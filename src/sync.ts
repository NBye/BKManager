import { bulkDelete, bulkUpsert, ensureIndex, fetchAllNodes } from './es';
import { clearProfile, getMeta, getNodes, getOperations, persistLocalChangesDb, putMeta, putOperation, replaceNodesAndRemoveOperations } from './db';
import { ensureEsPermission } from './config';
import { findInvalidNodeIds } from './nodes';
import type { BookmarkNode, ConnectionConfig, SyncOperation } from './types';
import { getProfileKey, now, OFFLINE_PROFILE_KEY } from './types';

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syncingProfiles = new Set<string>();
const pendingProfiles = new Map<string, ConnectionConfig>();
const MAX_SYNC_ATTEMPTS = 8;

function retryDelay(attempts: number): number {
  return Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

async function recordSyncFailure(profileKey: string, error: unknown): Promise<string> {
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
  return message;
}

function getDeletedOrInvalidRemoteIds(nodes: BookmarkNode[]): Set<string> {
  const deleteIds = findInvalidNodeIds(nodes);
  for (const node of nodes) {
    if (node.deletedAt) deleteIds.add(node.id);
  }
  return deleteIds;
}

async function fetchAndRepairRemote(config: ConnectionConfig): Promise<BookmarkNode[]> {
  const remoteNodes = await fetchAllNodes(config);
  const deleteIds = getDeletedOrInvalidRemoteIds(remoteNodes);
  if (deleteIds.size) {
    const result = await bulkDelete(config, [...deleteIds]);
    if (result.failed.length) {
      throw new Error(`ES 异常节点清理失败：${result.failed.slice(0, 3).map((item) => `${item.id || '未知节点'}：${item.reason}`).join('；')}`);
    }
  }
  return remoteNodes.filter((node) => !deleteIds.has(node.id));
}

function nodeSignature(node: BookmarkNode): string {
  return JSON.stringify([
    node.id, node.nodeType, node.parentId, node.name, node.url, node.urlKey, node.title,
    node.iconUrl, node.content, node.sortOrder, node.createdAt, node.updatedAt,
    node.revision, node.updatedBy, node.deletedAt ?? null
  ]);
}

function mergeForGraphValidation(remoteNodes: BookmarkNode[], localNodes: BookmarkNode[]): BookmarkNode[] {
  const remoteIds = new Set(remoteNodes.map((node) => node.id));
  return [...remoteNodes, ...localNodes.filter((node) => !remoteIds.has(node.id))];
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

export async function syncProfile(config: ConnectionConfig, _forceFull = false): Promise<void> {
  const profileKey = getProfileKey(config);
  await setStatus(profileKey, 'syncing');
  try {
    await ensureEsPermission(config);
    await ensureIndex(config);
    const localNodes = await getNodes(profileKey);
    const operations = await getOperations(profileKey);
    let remoteNodes = await fetchAndRepairRemote(config);
    const remoteById = new Map(remoteNodes.map((node) => [node.id, node]));
    const localById = new Map(localNodes.map((node) => [node.id, node]));
    const invalidLocalIds = findInvalidNodeIds(mergeForGraphValidation(remoteNodes, localNodes));
    const explicitDeleteIds = operations
      .filter((operation) => operation.action === 'delete')
      .map((operation) => operation.nodeId);
    const deleteIds = new Set([
      ...explicitDeleteIds.filter((id) => remoteById.has(id)),
      ...[...invalidLocalIds].filter((id) => remoteById.has(id))
    ]);
    if (deleteIds.size) {
      const result = await bulkDelete(config, [...deleteIds]);
      if (result.failed.length) {
        throw new Error(`删除 ES 节点失败：${result.failed.slice(0, 3).map((item) => `${item.id || '未知节点'}：${item.reason}`).join('；')}`);
      }
    }

    const uploadById = new Map<string, BookmarkNode>();
    const completedOperationIds: string[] = [];
    for (const operation of operations) {
      if (operation.action === 'delete') {
        if (!remoteById.has(operation.nodeId)) completedOperationIds.push(operation.id);
        continue;
      }
      const node = localById.get(operation.nodeId) ?? operation.data;
      if (!node || node.deletedAt || invalidLocalIds.has(node.id)) {
        completedOperationIds.push(operation.id);
        continue;
      }
      const remote = remoteById.get(node.id);
      if (remote && nodeSignature(remote) === nodeSignature(node)) {
        completedOperationIds.push(operation.id);
        continue;
      }
      uploadById.set(node.id, node);
    }
    if (uploadById.size) {
      const result = await bulkUpsert(config, [...uploadById.values()]);
      if (result.failed.length) {
        throw new Error(`上传 ES 节点失败：${result.failed.slice(0, 3).map((item) => `${item.id || '未知节点'}：${item.reason}`).join('；')}`);
      }
    }

    const nextRemoteById = new Map(remoteNodes.filter((node) => !deleteIds.has(node.id)).map((node) => [node.id, node]));
    for (const node of uploadById.values()) nextRemoteById.set(node.id, node);
    remoteNodes = [...nextRemoteById.values()];
    await replaceNodesAndRemoveOperations(profileKey, remoteNodes, completedOperationIds);
    const syncedAt = now();
    await putMeta({
      ...(await getMeta(profileKey)),
      profileKey,
      lastSyncAt: syncedAt,
      lastFullSyncAt: syncedAt,
      localDataUpdatedAt: syncedAt,
      syncStatus: 'idle',
      lastError: undefined
    });
  } catch (error) {
    const message = await recordSyncFailure(profileKey, error);
    throw new Error(message);
  }
}

export async function bindProfile(config: ConnectionConfig): Promise<void> {
  const profileKey = getProfileKey(config);
  await setStatus(profileKey, 'syncing');
  try {
    await ensureEsPermission(config);
    await ensureIndex(config);
    const offlineNodes = await getNodes(OFFLINE_PROFILE_KEY);
    let remoteNodes = await fetchAndRepairRemote(config);
    const remoteIds = new Set(remoteNodes.map((node) => node.id));
    const invalidOfflineIds = findInvalidNodeIds(mergeForGraphValidation(remoteNodes, offlineNodes));
    const offlineToUpload = offlineNodes.filter((node) => !node.deletedAt && !remoteIds.has(node.id) && !invalidOfflineIds.has(node.id));
    if (offlineToUpload.length) {
      const result = await bulkUpsert(config, offlineToUpload);
      if (result.failed.length) {
        throw new Error(`上传离线节点失败：${result.failed.slice(0, 3).map((item) => `${item.id || '未知节点'}：${item.reason}`).join('；')}`);
      }
    }
    for (const node of offlineToUpload) remoteNodes = [...remoteNodes, node];
    await replaceNodesAndRemoveOperations(profileKey, remoteNodes);
    await clearOfflineProfile();
    const syncedAt = now();
    await putMeta({
      ...(await getMeta(profileKey)),
      profileKey,
      lastSyncAt: syncedAt,
      lastFullSyncAt: syncedAt,
      localDataUpdatedAt: syncedAt,
      syncStatus: 'idle',
      lastError: undefined
    });
  } catch (error) {
    const message = await recordSyncFailure(profileKey, error);
    throw new Error(message);
  }
}

export async function clearOfflineProfile(): Promise<void> {
  await clearProfile(OFFLINE_PROFILE_KEY);
}

export async function initializeProfile(config: ConnectionConfig): Promise<BookmarkNode[]> {
  await syncProfile(config, true);
  return getNodes(getProfileKey(config));
}
