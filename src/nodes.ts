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
        ? { ...node, title: getTextTitle(node.content ?? '') }
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
