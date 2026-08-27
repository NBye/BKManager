import { bulkDelete, bulkUpsert, ensureIndex, fetchAllNodes } from './es';
import { clearNodes, getMeta, getNodes, getOperations, putMeta, putNode, putOperation, removeNodes, removeOperations, removeOperationsByIds, putNodes } from './db';
import { sanitizeNodes } from './nodes';
import type { BookmarkNode, ConnectionConfig, SyncOperation } from './types';
import { getProfileKey, now, OFFLINE_PROFILE_KEY } from './types';

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syncingProfiles = new Set<string>();
const pendingProfiles = new Map<string, ConnectionConfig>();

function chooseNewer(left: BookmarkNode, right: BookmarkNode): BookmarkNode {
  return left.updatedAt >= right.updatedAt ? left : right;
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

export async function saveLocalNode(config: ConnectionConfig | null, node: BookmarkNode, action: SyncOperation['action']): Promise<void> {
  const profileKey = getStorageProfileKey(config);
  await putNode(profileKey, node);
  const operations = await getOperations(profileKey);
  const existing = operations.find((operation) => operation.nodeId === node.id);
  const operation: SyncOperation = {
    id: existing?.id ?? crypto.randomUUID(),
    profileKey,
    nodeId: node.id,
    action,
    data: node,
    queuedAt: existing?.queuedAt ?? now(),
    attempts: existing?.attempts ?? 0
  };
  await putOperation(operation);
  const meta = await getMeta(profileKey);
  await putMeta({ ...meta, profileKey, localDataUpdatedAt: now(), syncStatus: 'offline' });
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

export async function syncProfile(config: ConnectionConfig): Promise<void> {
  const profileKey = getProfileKey(config);
  await setStatus(profileKey, 'syncing');
  try {
    await ensureIndex(config);
    const localNodes = await getNodes(profileKey);
    const operationsAtStart = await getOperations(profileKey);
    const remoteNodes = await fetchAllNodes(config);
    const merged = sanitizeNodes(mergeNodes(localNodes, remoteNodes));
    const remoteById = new Map(remoteNodes.map((node) => [node.id, node]));
    const deleteIds = new Set<string>();
    for (const node of localNodes) {
      if (!node.deletedAt) continue;
      const remote = remoteById.get(node.id);
      if (!remote || remote.updatedAt <= node.updatedAt) deleteIds.add(node.id);
    }
    for (const node of remoteNodes) {
      if (!node.deletedAt) continue;
      const local = localNodes.find((item) => item.id === node.id);
      if (!local || local.updatedAt <= node.updatedAt) deleteIds.add(node.id);
    }
    await bulkUpsert(config, merged);
    await bulkDelete(config, [...deleteIds]);
    const operationsAtEnd = await getOperations(profileKey);
    const completedOperationIds = operationsAtStart
      .filter((operation) => {
        const current = operationsAtEnd.find((item) => item.id === operation.id);
        return current && current.queuedAt === operation.queuedAt && current.data.updatedAt === operation.data.updatedAt;
      })
      .map((operation) => operation.id);
    await putNodes(profileKey, merged);
    await removeNodes(profileKey, [...deleteIds]);
    await removeOperationsByIds(completedOperationIds);
    const remainingOperations = await getOperations(profileKey);
    await putMeta({ profileKey, lastSyncAt: now(), localDataUpdatedAt: now(), syncStatus: remainingOperations.length ? 'offline' : 'idle' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '同步失败';
    await setStatus(profileKey, 'error', message);
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
  const nodes = sanitizeNodes(remoteNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  await bulkDelete(config, [...new Set(remoteNodes.filter((node) => !nodeIds.has(node.id)).map((node) => node.id))]);
  await putNodes(profileKey, nodes);
  await putMeta({ profileKey, lastSyncAt: now(), localDataUpdatedAt: now(), syncStatus: 'idle' });
  return nodes;
}
