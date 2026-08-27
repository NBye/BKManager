import { getConfig, isConfigComplete } from './config';
import { getNodes } from './db';
import { getTextTitle, isSupportedBookmarkUrl, sanitizeNodes } from './nodes';
import { getStorageProfileKey, initializeProfile, requestSync, saveLocalNode, syncProfile } from './sync';
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

export async function loadNodes(config: ConnectionConfig | null): Promise<BookmarkNode[]> {
  const profileKey = getStorageProfileKey(config);
  if (config) {
    try {
      await initializeProfile(config);
    } catch {
    }
  }
  const nodes = await getNodes(profileKey);
  return sanitizeNodes(nodes);
}

async function loadLocalNodes(config: ConnectionConfig | null): Promise<BookmarkNode[]> {
  return sanitizeNodes(await getNodes(getStorageProfileKey(config)));
}

export async function persistNode(config: ConnectionConfig | null, node: BookmarkNode, action: 'create' | 'update' | 'delete'): Promise<void> {
  await persistNodes(config, [{ node, action }]);
}

export async function persistNodes(config: ConnectionConfig | null, entries: Array<{ node: BookmarkNode; action: 'create' | 'update' | 'delete' }>): Promise<void> {
  for (const entry of entries) await saveLocalNode(config, entry.node, entry.action);
  requestSync(config);
}

export async function createFolder(config: ConnectionConfig | null, parentId: string | null, name: string): Promise<BookmarkNode> {
  const nodes = await loadLocalNodes(config);
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

export async function createBookmark(config: ConnectionConfig | null, parentId: string | null, url: string, title: string, iconUrl?: string): Promise<BookmarkNode> {
  const nodes = await loadLocalNodes(config);
  const normalizedUrl = normalizeUrl(url);
  if (!isSupportedBookmarkUrl(normalizedUrl)) throw new Error('只允许收藏 HTTP 或 HTTPS 网页地址。');
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

export async function createText(config: ConnectionConfig | null, parentId: string | null, content: string): Promise<BookmarkNode> {
  if (!content.trim()) throw new Error('选中的文案不能为空。');
  const nodes = await loadLocalNodes(config);
  const siblings = nodes.filter((node) => node.parentId === parentId);
  const node: BookmarkNode = {
    id: makeId(),
    nodeType: 'text',
    parentId,
    title: getTextTitle(content),
    content,
    sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000,
    createdAt: now(),
    updatedAt: now()
  };
  await persistNode(config, node, 'create');
  return node;
}

export async function updateNode(config: ConnectionConfig | null, node: BookmarkNode, changes: Partial<BookmarkNode>): Promise<BookmarkNode> {
  const next = { ...node, ...changes, updatedAt: now() };
  if (next.nodeType === 'text' && typeof next.content === 'string') {
    if (!next.content.trim()) throw new Error('文案内容不能为空。');
    next.title = getTextTitle(next.content);
  }
  if (next.nodeType === 'bookmark' && next.url) {
    next.url = normalizeUrl(next.url);
    if (!isSupportedBookmarkUrl(next.url)) throw new Error('只允许收藏 HTTP 或 HTTPS 网页地址。');
    next.urlKey = next.url;
    const nodes = await loadLocalNodes(config);
    const duplicate = nodes.find((item) => item.nodeType === 'bookmark' && item.urlKey === next.urlKey && item.id !== node.id);
    if (duplicate) throw new Error('该地址已经存在，不能创建重复收藏。');
  }
  await persistNode(config, next, 'update');
  return next;
}

export async function deleteSubtree(config: ConnectionConfig | null, nodeId: string): Promise<string[]> {
  const nodes = await loadLocalNodes(config);
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
  return [...toDelete];
}

export async function moveNode(config: ConnectionConfig | null, draggedId: string, targetId: string, mode: 'before' | 'after' | 'inside'): Promise<BookmarkNode[]> {
  const nodes = await loadLocalNodes(config);
  const dragged = nodes.find((node) => node.id === draggedId);
  const target = nodes.find((node) => node.id === targetId);
  if (!dragged || !target || dragged.id === target.id) return [];
  const destinationParentId = target.nodeType === 'folder' && mode === 'inside' ? target.id : target.parentId;
  if (dragged.nodeType === 'folder') {
    let ancestorId = destinationParentId;
    const visited = new Set<string>();
    while (ancestorId) {
      if (ancestorId === dragged.id) throw new Error('不能将目录移动到自己或自己的子目录中。');
      if (visited.has(ancestorId)) throw new Error('目标目录层级异常，无法移动。');
      visited.add(ancestorId);
      ancestorId = nodes.find((node) => node.id === ancestorId)?.parentId ?? null;
    }
  }
  if (target.nodeType === 'folder' && mode === 'inside') {
    const siblings = nodes.filter((node) => node.parentId === target.id && node.id !== dragged.id);
    const next = { ...dragged, parentId: target.id, sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000, updatedAt: now() };
    await persistNode(config, next, 'update');
    return [next];
  }
  const parentId = target.parentId;
  const siblings = nodes.filter((node) => node.parentId === parentId && node.id !== dragged.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const targetIndex = siblings.findIndex((node) => node.id === target.id);
  const insertAt = Math.max(0, targetIndex + (mode === 'after' ? 1 : 0));
  const reordered = [...siblings.slice(0, insertAt), dragged, ...siblings.slice(insertAt)];
  const updatedAt = now();
  const updated = reordered.map((item, index) => ({ ...item, parentId, sortOrder: (index + 1) * 1000, updatedAt }));
  await persistNodes(config, updated.map((node) => ({
    node,
    action: 'update' as const
  })));
  return updated;
}

export async function syncNow(config: ConnectionConfig): Promise<void> {
  await syncProfile(config);
}

export function getDisplayName(node: BookmarkNode): string {
  return node.nodeType === 'folder' ? (node.name ?? '未命名目录') : (node.title ?? node.url ?? '未命名收藏');
}
