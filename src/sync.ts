import { bulkDelete, bulkUpsert, ensureIndex, fetchAllNodes } from './es';
import { getMeta, getNodes, getOperations, putMeta, putNode, putOperation, removeOperations, putNodes } from './db';
import { nodeIdentity, sanitizeNodes } from './nodes';
import type { BookmarkNode, ConnectionConfig, SyncOperation } from './types';
import { getProfileKey, now } from './types';

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syncingProfiles = new Set<string>();
const pendingProfiles = new Map<string, ConnectionConfig>();

function chooseNewer(left: BookmarkNode, right: BookmarkNode): BookmarkNode {
  return left.updatedAt >= right.updatedAt ? left : right;
}

function mergeNodes(localNodes: BookmarkNode[], remoteNodes: BookmarkNode[]): BookmarkNode[] {
  const merged = new Map<string, BookmarkNode>();
  for (const node of localNodes) merged.set(nodeIdentity(node), node);
  for (const node of remoteNodes) {
    const key = nodeIdentity(node);
    const current = merged.get(key);
    merged.set(key, current ? chooseNewer(current, node) : node);
  }
  return [...merged.values()];
}

async function setStatus(profileKey: string, status: 'idle' | 'syncing' | 'offline' | 'error', error?: string) {
  const meta = await getMeta(profileKey);
  await putMeta({ ...meta, profileKey, syncStatus: status, lastError: error });
}

export async function saveLocalNode(config: ConnectionConfig, node: BookmarkNode, action: SyncOperation['action']): Promise<void> {
  const profileKey = getProfileKey(config);
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

export function requestSync(config: ConnectionConfig): void {
  void chrome.runtime.sendMessage({ type: 'schedule-sync' }).catch(() => scheduleSync(config));
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
    const mergedIds = new Set(merged.map((node) => node.id));
    const staleRemoteIds = [...new Set(remoteNodes.filter((node) => !mergedIds.has(node.id)).map((node) => node.id))];
    await bulkDelete(config, staleRemoteIds);
    await bulkUpsert(config, merged);
    const operationsAtEnd = await getOperations(profileKey);
    const changedDuringSync = operationsAtStart.length !== operationsAtEnd.length
      || operationsAtStart.some((operation) => {
        const current = operationsAtEnd.find((item) => item.id === operation.id);
        return !current || current.queuedAt !== operation.queuedAt || current.data.updatedAt !== operation.data.updatedAt;
    });
    if (!changedDuringSync) {
      await putNodes(profileKey, merged);
      await removeOperations(profileKey);
    }
    await putMeta({ profileKey, lastSyncAt: now(), localDataUpdatedAt: now(), syncStatus: 'idle' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '同步失败';
    await setStatus(profileKey, 'error', message);
    throw error;
  }
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
