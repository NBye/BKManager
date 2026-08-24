import { bulkUpsert, ensureIndex, fetchAllNodes } from './es';
import { getMeta, getNodes, getOperations, putMeta, putNode, putOperation, removeOperations, putNodes } from './db';
import type { BookmarkNode, ConnectionConfig, SyncOperation } from './types';
import { getProfileKey, now } from './types';

function identity(node: BookmarkNode): string {
  return node.nodeType === 'bookmark' ? `bookmark:${node.urlKey ?? node.url}` : `folder:${node.id}`;
}

function chooseNewer(left: BookmarkNode, right: BookmarkNode): BookmarkNode {
  return left.updatedAt >= right.updatedAt ? left : right;
}

function mergeNodes(localNodes: BookmarkNode[], remoteNodes: BookmarkNode[]): BookmarkNode[] {
  const merged = new Map<string, BookmarkNode>();
  for (const node of localNodes) merged.set(identity(node), node);
  for (const node of remoteNodes) {
    const key = identity(node);
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

export async function syncProfile(config: ConnectionConfig): Promise<void> {
  const profileKey = getProfileKey(config);
  await setStatus(profileKey, 'syncing');
  try {
    await ensureIndex(config);
    const localNodes = await getNodes(profileKey);
    const remoteNodes = await fetchAllNodes(config);
    const merged = mergeNodes(localNodes, remoteNodes);
    await bulkUpsert(config, merged);
    await putNodes(profileKey, merged);
    await removeOperations(profileKey);
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
  await putNodes(profileKey, remoteNodes);
  await putMeta({ profileKey, lastSyncAt: now(), localDataUpdatedAt: now(), syncStatus: 'idle' });
  return remoteNodes;
}
