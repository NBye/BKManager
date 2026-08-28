import type { BookmarkNode } from './types';
import { normalizeUrl } from './types';

export function isSupportedBookmarkUrl(value: string): boolean {
  try {
    const url = new URL(normalizeUrl(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getTextTitle(content: string): string {
  return Array.from(content).slice(0, 20).join('');
}

export interface NodeValidationResult {
  node: BookmarkNode | null;
  error?: string;
}

export function parseNode(value: unknown): NodeValidationResult {
  if (!value || typeof value !== 'object') return { node: null, error: '节点必须是对象。' };
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return { node: null, error: '缺少有效 id。' };
  if (!['folder', 'bookmark', 'text'].includes(candidate.nodeType as string)) return { node: null, error: 'nodeType 不受支持。' };
  if (candidate.parentId !== null && typeof candidate.parentId !== 'string') return { node: null, error: 'parentId 必须是字符串或 null。' };
  if (!Number.isFinite(candidate.sortOrder) || typeof candidate.sortOrder !== 'number') return { node: null, error: 'sortOrder 必须是数字。' };
  if (!Number.isFinite(candidate.updatedAt) || typeof candidate.updatedAt !== 'number') return { node: null, error: 'updatedAt 必须是数字。' };
  if (candidate.createdAt !== undefined && (!Number.isFinite(candidate.createdAt) || typeof candidate.createdAt !== 'number')) return { node: null, error: 'createdAt 必须是数字。' };
  if (candidate.deletedAt !== undefined && candidate.deletedAt !== null && (!Number.isFinite(candidate.deletedAt) || typeof candidate.deletedAt !== 'number')) return { node: null, error: 'deletedAt 必须是数字或 null。' };
  if (candidate.nodeType === 'folder' && (typeof candidate.name !== 'string' || !candidate.name.trim())) return { node: null, error: '目录缺少 name。' };
  if (candidate.nodeType === 'bookmark' && (typeof candidate.url !== 'string' || !isSupportedBookmarkUrl(candidate.url))) return { node: null, error: '链接地址无效。' };
  if (candidate.nodeType === 'text' && (typeof candidate.content !== 'string' || !candidate.content.trim())) return { node: null, error: '文案内容不能为空。' };
  const node = { ...candidate, id: candidate.id.trim(), parentId: candidate.parentId as string | null } as BookmarkNode;
  if (node.nodeType === 'bookmark') {
    node.url = normalizeUrl(node.url ?? '');
    node.urlKey = node.url;
  }
  if (node.nodeType === 'text' && (typeof node.title !== 'string' || !node.title.trim())) {
    node.title = getTextTitle(node.content ?? '');
  }
  return { node };
}

export function parseNodes(values: unknown[]): { nodes: BookmarkNode[]; errors: string[] } {
  const nodes: BookmarkNode[] = [];
  const errors: string[] = [];
  values.forEach((value, index) => {
    const result = parseNode(value);
    if (result.node) nodes.push(result.node);
    else errors.push(`第 ${index + 1} 个节点：${result.error ?? '格式无效'}`);
  });
  return { nodes, errors };
}

export function validateNodeGraph(nodes: BookmarkNode[]): string[] {
  const errors: string[] = [];
  const byId = new Map<string, BookmarkNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) errors.push(`节点 ID 重复：${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = byId.get(node.parentId);
    if (!parent) errors.push(`节点 ${node.id} 的父目录不存在：${node.parentId}`);
    else if (parent.nodeType !== 'folder') errors.push(`节点 ${node.id} 的父节点不是目录：${node.parentId}`);
    const visited = new Set<string>([node.id]);
    let currentId: string | null = node.parentId;
    while (currentId) {
      if (visited.has(currentId)) {
        errors.push(`节点 ${node.id} 所在目录存在循环引用。`);
        break;
      }
      visited.add(currentId);
      currentId = byId.get(currentId)?.parentId ?? null;
    }
  }
  return errors;
}

export function findInvalidNodeIds(nodes: BookmarkNode[]): Set<string> {
  const byId = new Map<string, BookmarkNode>();
  for (const node of nodes) byId.set(node.id, node);
  const invalid = new Set<string>();

  for (const node of nodes) {
    if (node.deletedAt) continue;
    const path: string[] = [];
    const visited = new Set<string>();
    let current: BookmarkNode | undefined = node;
    while (current && !current.deletedAt) {
      if (visited.has(current.id)) {
        const cycleStart = path.indexOf(current.id);
        for (const id of path.slice(cycleStart < 0 ? 0 : cycleStart)) invalid.add(id);
        break;
      }
      visited.add(current.id);
      path.push(current.id);
      if (current.parentId === null) break;
      const parent = byId.get(current.parentId);
      if (!parent || parent.deletedAt || parent.nodeType !== 'folder') {
        for (const id of path) invalid.add(id);
        break;
      }
      current = parent;
    }
    if (current?.deletedAt) {
      for (const id of path) invalid.add(id);
    }
    if (current && invalid.has(current.id)) {
      for (const id of path) invalid.add(id);
    }
  }

  return invalid;
}

export function parseBackup(value: unknown): { nodes: BookmarkNode[]; errors: string[] } {
  if (!value || typeof value !== 'object') return { nodes: [], errors: ['备份内容必须是对象。'] };
  const backup = value as Record<string, unknown>;
  if (backup.format !== 'bookmark-manager-backup' || backup.version !== 1 || !Array.isArray(backup.nodes)) {
    return { nodes: [], errors: ['备份文件格式不正确。'] };
  }
  const parsed = parseNodes(backup.nodes);
  return { nodes: parsed.nodes, errors: [...parsed.errors, ...validateNodeGraph(parsed.nodes)] };
}

export function sanitizeNodes(nodes: BookmarkNode[]): BookmarkNode[] {
  const newestById = new Map<string, BookmarkNode>();
  for (const node of nodes) {
    const current = newestById.get(node.id);
    if (!current || node.updatedAt >= current.updatedAt) newestById.set(node.id, node);
  }

  const normalized = [...newestById.values()]
    .filter((node) => !node.deletedAt)
    .filter((node) => node.nodeType === 'folder'
      || (node.nodeType === 'bookmark' && isSupportedBookmarkUrl(node.url ?? ''))
      || (node.nodeType === 'text' && typeof node.content === 'string' && node.content.trim().length > 0))
    .map((node) => node.nodeType === 'bookmark'
      ? { ...node, url: normalizeUrl(node.url ?? ''), urlKey: normalizeUrl(node.url ?? '') }
      : node.nodeType === 'text'
        ? { ...node, title: node.title?.trim() ? node.title : getTextTitle(node.content ?? '') }
      : node);
  const folders = normalized.filter((node) => node.nodeType === 'folder');
  const texts = normalized.filter((node) => node.nodeType === 'text');
  const bookmarksByUrl = new Map<string, BookmarkNode>();
  for (const node of normalized) {
    if (node.nodeType !== 'bookmark') continue;
    const url = node.urlKey ?? node.url ?? '';
    const current = bookmarksByUrl.get(url);
    if (!current || node.updatedAt >= current.updatedAt) bookmarksByUrl.set(url, node);
  }
  const candidates = [...folders, ...bookmarksByUrl.values(), ...texts];
  const byId = new Map(candidates.map((node) => [node.id, node]));
  const folderState = new Map<string, 'visiting' | 'valid' | 'invalid'>();

  const isValidFolder = (id: string): boolean => {
    const state = folderState.get(id);
    if (state === 'valid') return true;
    if (state === 'invalid' || state === 'visiting') return false;
    const folder = byId.get(id);
    if (!folder || folder.nodeType !== 'folder') return false;
    folderState.set(id, 'visiting');
    const valid = folder.parentId === null || isValidFolder(folder.parentId);
    folderState.set(id, valid ? 'valid' : 'invalid');
    return valid;
  };

  return candidates
    .filter((node) => node.nodeType === 'folder'
      ? isValidFolder(node.id)
      : node.parentId === null || isValidFolder(node.parentId))
    .map((node) => ({ ...node, createdAt: node.createdAt ?? node.updatedAt }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}
