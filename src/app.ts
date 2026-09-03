import { getConfig, isConfigComplete } from './config';
import { getNodes } from './db';
import { getTextTitle, isBase64IconUrl, isSupportedBookmarkUrl, sanitizeNodes } from './nodes';
import { getStorageProfileKey, initializeProfile, persistLocalChanges, requestSync, syncProfile } from './sync';
import type { BookmarkNode, ConnectionConfig, NodeType } from './types';
import { getProfileKey, makeId, normalizeUrl, now } from './types';
import { getNodeTitle } from './node-service';

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
  const cachedNodes = await getNodes(profileKey);
  if (!config || cachedNodes.length) return sanitizeNodes(cachedNodes);
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
  await persistLocalChanges(config, entries);
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
    updatedAt: now(),
    revision: 1,
    updatedBy: config?.profileId ?? 'offline'
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
    iconUrl: isBase64IconUrl(iconUrl) ? undefined : iconUrl,
    sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000,
    createdAt: now(),
    updatedAt: now(),
    revision: 1,
    updatedBy: config?.profileId ?? 'offline'
  };
  await persistNode(config, node, 'create');
  return node;
}

export async function createText(config: ConnectionConfig | null, parentId: string | null, content: string, title?: string): Promise<BookmarkNode> {
  if (!content.trim()) throw new Error('选中的文案不能为空。');
  const nodes = await loadLocalNodes(config);
  const siblings = nodes.filter((node) => node.parentId === parentId);
  const node: BookmarkNode = {
    id: makeId(),
    nodeType: 'text',
    parentId,
    title: title?.trim() || getTextTitle(content),
    content,
    sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000,
    createdAt: now(),
    updatedAt: now(),
    revision: 1,
    updatedBy: config?.profileId ?? 'offline'
  };
  await persistNode(config, node, 'create');
  return node;
}

export async function updateNode(config: ConnectionConfig | null, node: BookmarkNode, changes: Partial<BookmarkNode>): Promise<BookmarkNode> {
  const next = { ...node, ...changes, updatedAt: now(), revision: (node.revision ?? 0) + 1, updatedBy: config?.profileId ?? 'offline' };
  let localNodes: BookmarkNode[] | null = null;
  if ('parentId' in changes && next.parentId) {
    localNodes = await loadLocalNodes(config);
    const parent = localNodes.find((item) => item.id === next.parentId);
    if (!parent || parent.nodeType !== 'folder') throw new Error('所选保存目录不存在。');
    if (next.nodeType === 'folder') {
      const visited = new Set<string>();
      let ancestorId: string | null = next.parentId;
      while (ancestorId) {
        if (ancestorId === next.id) throw new Error('不能将文件夹移动到自己或自己的子目录中。');
        if (visited.has(ancestorId)) throw new Error('目标目录层级异常，无法移动。');
        visited.add(ancestorId);
        ancestorId = localNodes.find((item) => item.id === ancestorId)?.parentId ?? null;
      }
    }
  }
  if (isBase64IconUrl(next.iconUrl)) next.iconUrl = undefined;
  if (next.nodeType === 'text' && typeof next.content === 'string') {
    if (!next.content.trim()) throw new Error('文案内容不能为空。');
    if (!next.title?.trim()) next.title = getTextTitle(next.content);
  }
  if (next.nodeType === 'bookmark' && next.url) {
    next.url = normalizeUrl(next.url);
    if (!isSupportedBookmarkUrl(next.url)) throw new Error('只允许收藏 HTTP 或 HTTPS 网页地址。');
    next.urlKey = next.url;
    localNodes ??= await loadLocalNodes(config);
    const duplicate = localNodes.find((item) => item.nodeType === 'bookmark' && item.urlKey === next.urlKey && item.id !== node.id);
    if (duplicate) throw new Error('该地址已经存在，不能创建重复收藏。');
  }
  await persistNode(config, next, 'update');
  return next;
}

export async function deleteSubtree(config: ConnectionConfig | null, nodeId: string, additionalNodes: BookmarkNode[] = []): Promise<string[]> {
  const localNodes = await loadLocalNodes(config);
  const nodes = [...new Map([...localNodes, ...additionalNodes].map((node) => [node.id, node])).values()];
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
    node: { ...node, deletedAt: now(), updatedAt: now(), revision: (node.revision ?? 0) + 1, updatedBy: config?.profileId ?? 'offline' },
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
    const next = { ...dragged, parentId: target.id, sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1000 : 1000, updatedAt: now(), revision: (dragged.revision ?? 0) + 1, updatedBy: config?.profileId ?? 'offline' };
    await persistNode(config, next, 'update');
    return [next];
  }
  const parentId = target.parentId;
  const siblings = nodes.filter((node) => node.parentId === parentId && node.id !== dragged.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const targetIndex = siblings.findIndex((node) => node.id === target.id);
  const insertAt = Math.max(0, targetIndex + (mode === 'after' ? 1 : 0));
  const reordered = [...siblings.slice(0, insertAt), dragged, ...siblings.slice(insertAt)];
  const updatedAt = now();
  const updated = reordered.map((item, index) => ({ ...item, parentId, sortOrder: (index + 1) * 1000, updatedAt, revision: (item.revision ?? 0) + 1, updatedBy: config?.profileId ?? 'offline' }));
  await persistNodes(config, updated.map((node) => ({
    node,
    action: 'update' as const
  })));
  return updated;
}

export async function moveNodeUp(config: ConnectionConfig | null, nodeId: string): Promise<BookmarkNode[]> {
  const nodes = await loadLocalNodes(config);
  const node = nodes.find((item) => item.id === nodeId);
  if (!node?.parentId) return [];
  const parent = nodes.find((item) => item.id === node.parentId && item.nodeType === 'folder');
  if (!parent) throw new Error('当前节点的父目录不存在，无法上移。');
  const destinationParentId = parent.parentId;
  const siblings = nodes.filter((item) => item.parentId === destinationParentId && item.id !== node.id).sort((left, right) => left.sortOrder - right.sortOrder);
  const parentIndex = siblings.findIndex((item) => item.id === parent.id);
  const insertAt = parentIndex < 0 ? siblings.length : parentIndex + 1;
  const reordered = [...siblings.slice(0, insertAt), node, ...siblings.slice(insertAt)];
  const updatedAt = now();
  const updated = reordered.map((item, index) => ({
    ...item,
    parentId: destinationParentId,
    sortOrder: (index + 1) * 1000,
    updatedAt,
    revision: (item.revision ?? 0) + 1,
    updatedBy: config?.profileId ?? 'offline'
  }));
  await persistNodes(config, updated.map((item) => ({ node: item, action: 'update' as const })));
  return updated;
}

export async function syncNow(config: ConnectionConfig, forceFull = false): Promise<void> {
  await syncProfile(config, forceFull);
}

export function getDisplayName(node: BookmarkNode): string {
  return getNodeTitle(node);
}
