import { bulkUpsert, ensureIndex, fetchAllNodes, fetchNodesSince } from './es';
import { clearNodes, getMeta, getNodes, getOperations, persistLocalChangesDb, putMeta, putOperation, removeOperations, removeOperationsByIds, putNodes } from './db';
import { validateNodeGraph } from './nodes';
import { ensureEsPermission } from './config';
import type { BookmarkNode, ConnectionConfig, SyncOperation } from './types';
import { getProfileKey, now, OFFLINE_PROFILE_KEY } from './types';

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syncingProfiles = new Set<string>();
const pendingProfiles = new Map<string, ConnectionConfig>();
const MAX_SYNC_ATTEMPTS = 8;

function retryDelay(attempts: number): number {
  return Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

function chooseNewer(left: BookmarkNode, right: BookmarkNode): BookmarkNode {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right;
  if ((left.revision ?? 0) !== (right.revision ?? 0)) return (left.revision ?? 0) > (right.revision ?? 0) ? left : right;
  if ((left.updatedBy ?? '') !== (right.updatedBy ?? '')) return (left.updatedBy ?? '') > (right.updatedBy ?? '') ? left : right;
  const leftSignature = JSON.stringify({ ...left, updatedAt: undefined });
  const rightSignature = JSON.stringify({ ...right, updatedAt: undefined });
  return leftSignature >= rightSignature ? left : right;
}

function mergeNodes(localNodes: BookmarkNode[], remoteNodes: BookmarkNode[]): BookmarkNode[] {
  const merged = new Map<string, BookmarkNode>();
  for (const node of localNodes) merged.set(node.id, node);
  for (const node of remoteNodes) {
    const current = merged.get(node.id);
    merged.set(node.id, current ? chooseNewer(current, node) : node);
  }
  return [...merged.values()];
}

async function setStatus(profileKey: string, status: 'idle' | 'syncing' | 'offline' | 'error', error?: string) {
  const meta = await getMeta(profileKey);
  await putMeta({ ...meta, profileKey, syncStatus: status, lastError: error });
}

export function getStorageProfileKey(config: ConnectionConfig | null): string {
  return config ? getProfileKey(config) : OFFLINE_PROFILE_KEY;
}

export async function persistLocalChanges(config: ConnectionConfig | null, entries: Array<{ node: BookmarkNode; action: SyncOperation['action'] }>): Promise<void> {
  const profileKey = getStorageProfileKey(config);
  const existing = await getOperations(profileKey);
  const existingByNode = new Map(existing.map((operation) => [operation.nodeId, operation]));
  const queuedAt = now();
  await persistLocalChangesDb(profileKey, entries.map(({ node, action }) => {
    const previous = existingByNode.get(node.id);
    return {
      node,
      operation: {
        id: previous?.id ?? crypto.randomUUID(),
        profileKey,
        nodeId: node.id,
        action,
        data: node,
        queuedAt: previous?.queuedAt ?? queuedAt,
        attempts: 0
      }
    };
  }), { ...(await getMeta(profileKey)), profileKey, localDataUpdatedAt: queuedAt, syncStatus: 'offline' });
}

export async function saveLocalNode(config: ConnectionConfig | null, node: BookmarkNode, action: SyncOperation['action']): Promise<void> {
  await persistLocalChanges(config, [{ node, action }]);
}

export function scheduleSync(config: ConnectionConfig): void {
  const profileKey = getProfileKey(config);
  pendingProfiles.set(profileKey, config);
  const existingTimer = syncTimers.get(profileKey);
  if (existingTimer) clearTimeout(existingTimer);
  if (syncingProfiles.has(profileKey)) return;
  syncTimers.set(profileKey, setTimeout(() => {
    syncTimers.delete(profileKey);
    const pendingConfig = pendingProfiles.get(profileKey);
    if (!pendingConfig) return;
    pendingProfiles.delete(profileKey);
    syncingProfiles.add(profileKey);
    void syncProfile(pendingConfig)
      .catch(() => undefined)
      .finally(() => {
        syncingProfiles.delete(profileKey);
        if (pendingProfiles.has(profileKey)) scheduleSync(pendingConfig);
      });
  }, 1000));
}

export function requestSync(config: ConnectionConfig | null): void {
  if (!config) return;
  void chrome.runtime.sendMessage({ type: 'schedule-sync' }).catch(() => scheduleSync(config));
}

export function cancelScheduledSyncs(): void {
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  pendingProfiles.clear();
}

export async function syncProfile(config: ConnectionConfig, forceFull = false): Promise<void> {
  const profileKey = getProfileKey(config);
  await setStatus(profileKey, 'syncing');
  try {
    await ensureEsPermission(config);
    await ensureIndex(config);
    const meta = await getMeta(profileKey);
    const localNodes = await getNodes(profileKey);
    const operationsAtStart = await getOperations(profileKey);
    const remoteNodes = forceFull || meta.lastSyncAt === undefined ? await fetchAllNodes(config) : await fetchNodesSince(config, meta.lastSyncAt);
    const merged = mergeNodes(localNodes, remoteNodes);
    if (forceFull || meta.lastSyncAt === undefined) {
      const graphErrors = validateNodeGraph(merged.filter((node) => !node.deletedAt));
      if (graphErrors.length) throw new Error(`ES 目录关系校验失败，已停止同步：${graphErrors.slice(0, 3).join('；')}`);
    }
    const localById = new Map(localNodes.map((node) => [node.id, node]));
    const uploadById = new Map<string, BookmarkNode>();
    for (const operation of operationsAtStart) {
      const node = merged.find((item) => item.id === operation.nodeId);
      if (node) uploadById.set(node.id, node);
    }
    for (const remote of remoteNodes) {
      const local = localById.get(remote.id);
      if (local && chooseNewer(local, remote) === local) uploadById.set(local.id, local);
    }
    const bulkResult = await bulkUpsert(config, [...uploadById.values()]);
    const operationsAtEnd = await getOperations(profileKey);
    const completedOperationIds = operationsAtStart
      .filter((operation) => {
        const current = operationsAtEnd.find((item) => item.id === operation.id);
        return current && current.queuedAt === operation.queuedAt && current.data.updatedAt === operation.data.updatedAt && bulkResult.succeededIds.includes(operation.nodeId);
      })
      .map((operation) => operation.id);
    await putNodes(profileKey, merged);
    await removeOperationsByIds(completedOperationIds);
    const remainingOperations = await getOperations(profileKey);
    const syncAt = Math.max(now(), ...remoteNodes.map((node) => node.updatedAt));
    await putMeta({ ...meta, profileKey, lastSyncAt: syncAt, lastFullSyncAt: forceFull || meta.lastFullSyncAt === undefined ? syncAt : meta.lastFullSyncAt, localDataUpdatedAt: now(), syncStatus: remainingOperations.length || bulkResult.failed.length ? 'error' : 'idle', lastError: bulkResult.failed.length ? `部分节点同步失败：${bulkResult.failed.length} 条` : undefined });
    if (bulkResult.failed.length) throw new Error(`部分节点同步失败：${bulkResult.failed.slice(0, 3).map((item) => `${item.id || '未知节点'}：${item.reason}`).join('；')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '同步失败';
    try {
      const operations = await getOperations(profileKey);
      const failedAt = now();
      for (const operation of operations) {
        const attempts = operation.attempts + 1;
        await putOperation({
          ...operation,
          attempts,
          lastAttemptAt: failedAt,
          nextRetryAt: attempts >= MAX_SYNC_ATTEMPTS ? undefined : failedAt + retryDelay(attempts),
          lastError: message
        });
      }
      await setStatus(profileKey, 'error', message);
    } catch {
      await setStatus(profileKey, 'error', message);
    }
    throw error;
  }
}

export async function migrateOfflineProfile(config: ConnectionConfig): Promise<boolean> {
  const offlineNodes = await getNodes(OFFLINE_PROFILE_KEY);
  if (!offlineNodes.length) return false;
  const targetProfileKey = getProfileKey(config);
  const targetNodes = await getNodes(targetProfileKey);
  const targetById = new Map(targetNodes.map((node) => [node.id, node]));
  for (const node of offlineNodes) {
    const existing = targetById.get(node.id);
    if (existing && existing.updatedAt > node.updatedAt) continue;
    await saveLocalNode(config, node, node.deletedAt ? 'delete' : 'create');
  }
  return true;
}

export async function clearOfflineProfile(): Promise<void> {
  await clearNodes(OFFLINE_PROFILE_KEY);
  await removeOperations(OFFLINE_PROFILE_KEY);
}

export async function initializeProfile(config: ConnectionConfig): Promise<BookmarkNode[]> {
  const profileKey = getProfileKey(config);
  const localNodes = await getNodes(profileKey);
  if (localNodes.length) return localNodes;
  await ensureIndex(config);
  const remoteNodes = await fetchAllNodes(config);
  const graphErrors = validateNodeGraph(remoteNodes.filter((node) => !node.deletedAt));
  if (graphErrors.length) throw new Error(`ES 目录关系校验失败，已停止初始化：${graphErrors.slice(0, 3).join('；')}`);
  await putNodes(profileKey, remoteNodes);
  await putMeta({ profileKey, lastSyncAt: now(), localDataUpdatedAt: now(), syncStatus: 'idle' });
  return remoteNodes;
}
