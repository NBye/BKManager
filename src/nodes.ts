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

export function nodeIdentity(node: BookmarkNode): string {
  if (node.nodeType === 'bookmark') {
    const url = normalizeUrl(node.urlKey ?? node.url ?? '');
    return url ? `bookmark:${url}` : `bookmark-id:${node.id}`;
  }
  return `folder:${node.id}`;
}

export function sanitizeNodes(nodes: BookmarkNode[]): BookmarkNode[] {
  const newest = new Map<string, BookmarkNode>();
  for (const node of nodes) {
    const key = nodeIdentity(node);
    const current = newest.get(key);
    if (!current || node.updatedAt >= current.updatedAt) newest.set(key, node);
  }

  const candidates = [...newest.values()]
    .filter((node) => !node.deletedAt)
    .filter((node) => node.nodeType === 'folder' || isSupportedBookmarkUrl(node.url ?? ''))
    .map((node) => node.nodeType === 'bookmark'
      ? { ...node, url: normalizeUrl(node.url ?? ''), urlKey: normalizeUrl(node.url ?? '') }
      : node);
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
