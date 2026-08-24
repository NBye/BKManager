import { getConfig, isConfigComplete } from './config';
import { getNodes } from './db';
import { initializeProfile, saveLocalNode, syncProfile } from './sync';
import type { BookmarkNode, ConnectionConfig, NodeType } from './types';
import { getProfileKey, makeId, normalizeUrl, now } from './types';

export class DuplicateBookmarkError extends Error {
  constructor(public readonly existing: BookmarkNode) {
    super(`该地址已经收藏：${existing.title ?? existing.url}`);
    this.name = 'DuplicateBookmarkError';
  }
}

export async function requireConfig(): Promise<ConnectionConfig> {
  const config = await getConfig();
  if (!isConfigComplete(config)) {
    throw new Error('请先在插件设置中配置 ES 地址、授权 Key 和索引前缀。');
  }
  return config;
}

export async function loadNodes(config: ConnectionConfig): Promise<BookmarkNode[]> {
  await initializeProfile(config);
  const nodes = await getNodes(getProfileKey(config));
  return nodes.filter((node) => !node.deletedAt).map((node) => ({ ...node, createdAt: node.createdAt ?? node.updatedAt })).sort((left, right) => left.sortOrder - right.sortOrder);
}

export async function persistNode(config: ConnectionConfig, node: BookmarkNode, action: 'create' | 'update' | 'delete'): Promise<void> {
  await persistNodes(config, [{ node, action }]);
}

export async function persistNodes(config: ConnectionConfig, entries: Array<{ node: BookmarkNode; action: 'create' | 'update' | 'delete' }>): Promise<void> {
  for (const entry of entries) await saveLocalNode(config, entry.node, entry.action);
  try {
    await syncProfile(config);
  } catch {
    // The local operation remains queued for a later manual sync.
  }
}

export async function createFolder(config: ConnectionConfig, parentId: string | null, name: string): Promise<BookmarkNode> {
  const nodes = await loadNodes(config);
  const siblings = nodes.filter((node) => node.parentId === parentId);
  const node: BookmarkNode = {
    id: makeId(),
    nodeType: 'folder',
    parentId,
    name: name.trim(),
    sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000,
    createdAt: now(),
    updatedAt: now()
  };
  await persistNode(config, node, 'create');
  return node;
}

export async function createBookmark(config: ConnectionConfig, parentId: string | null, url: string, title: string, iconUrl?: string): Promise<BookmarkNode> {
  const nodes = await loadNodes(config);
  const normalizedUrl = normalizeUrl(url);
  const duplicate = nodes.find((node) => node.nodeType === 'bookmark' && node.urlKey === normalizedUrl);
  if (duplicate) throw new DuplicateBookmarkError(duplicate);
  const siblings = nodes.filter((node) => node.parentId === parentId);
  const node: BookmarkNode = {
    id: makeId(),
    nodeType: 'bookmark',
    parentId,
    url: normalizedUrl,
    urlKey: normalizedUrl,
    title: title.trim() || normalizedUrl,
    iconUrl,
    sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000,
    createdAt: now(),
    updatedAt: now()
  };
  await persistNode(config, node, 'create');
  return node;
}

export async function updateNode(config: ConnectionConfig, node: BookmarkNode, changes: Partial<BookmarkNode>): Promise<BookmarkNode> {
  const next = { ...node, ...changes, updatedAt: now() };
  if (next.nodeType === 'bookmark' && next.url) {
    next.url = normalizeUrl(next.url);
    next.urlKey = next.url;
    const nodes = await loadNodes(config);
    const duplicate = nodes.find((item) => item.nodeType === 'bookmark' && item.urlKey === next.urlKey && item.id !== node.id);
    if (duplicate) throw new Error('该地址已经存在，不能创建重复收藏。');
  }
  await persistNode(config, next, 'update');
  return next;
}

export async function deleteSubtree(config: ConnectionConfig, nodeId: string): Promise<void> {
  const nodes = await loadNodes(config);
  const toDelete = new Set<string>([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && toDelete.has(node.parentId) && !toDelete.has(node.id)) {
        toDelete.add(node.id);
        changed = true;
      }
    }
  }
  await persistNodes(config, nodes.filter((item) => toDelete.has(item.id)).map((node) => ({
    node: { ...node, deletedAt: now(), updatedAt: now() },
    action: 'delete' as const
  })));
}

export async function moveNode(config: ConnectionConfig, draggedId: string, targetId: string, mode: 'before' | 'after' | 'inside'): Promise<void> {
  const nodes = await loadNodes(config);
  const dragged = nodes.find((node) => node.id === draggedId);
  const target = nodes.find((node) => node.id === targetId);
  if (!dragged || !target || dragged.id === target.id) return;
  if (target.nodeType === 'folder' && mode === 'inside') {
    let parent = target;
    while (parent.parentId) {
      if (parent.parentId === dragged.id) throw new Error('不能将目录移动到自己的子目录。');
      parent = nodes.find((node) => node.id === parent.parentId) ?? parent;
    }
    const siblings = nodes.filter((node) => node.parentId === target.id && node.id !== dragged.id);
    const next = { ...dragged, parentId: target.id, sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000, updatedAt: now() };
    await persistNode(config, next, 'update');
    return;
  }
  const parentId = target.parentId;
  const siblings = nodes.filter((node) => node.parentId === parentId && node.id !== dragged.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const targetIndex = siblings.findIndex((node) => node.id === target.id);
  const insertAt = Math.max(0, targetIndex + (mode === 'after' ? 1 : 0));
  const reordered = [...siblings.slice(0, insertAt), dragged, ...siblings.slice(insertAt)];
  await persistNodes(config, reordered.map((item, index) => ({
    node: { ...item, parentId, sortOrder: (index + 1) * 1000, updatedAt: now() },
    action: 'update' as const
  })));
}

export async function syncNow(config: ConnectionConfig): Promise<void> {
  await syncProfile(config);
}

export function getDisplayName(node: BookmarkNode): string {
  return node.nodeType === 'folder' ? (node.name ?? '未命名目录') : (node.title ?? node.url ?? '未命名收藏');
}
