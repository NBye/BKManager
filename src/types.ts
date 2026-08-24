export type NodeType = 'folder' | 'bookmark';

export interface BookmarkNode {
  id: string;
  nodeType: NodeType;
  parentId: string | null;
  name?: string;
  url?: string;
  title?: string;
  iconUrl?: string;
  urlKey?: string;
  sortOrder: number;
  createdAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface ConnectionConfig {
  esUrl: string;
  apiKey: string;
  indexPrefix: string;
}

export interface SyncOperation {
  id: string;
  profileKey: string;
  nodeId: string;
  action: 'create' | 'update' | 'delete';
  data: BookmarkNode;
  queuedAt: number;
  attempts: number;
}

export interface SyncMeta {
  profileKey: string;
  lastSyncAt?: number;
  localDataUpdatedAt?: number;
  syncStatus?: 'idle' | 'syncing' | 'offline' | 'error';
  lastError?: string;
}

export interface BackupFile {
  format: 'bookmark-manager-backup';
  version: 1;
  exportedAt: string;
  nodes: BookmarkNode[];
}

export const ROOT_ID = null;

export function now(): number {
  return Date.now();
}

export function normalizeUrl(url: string): string {
  return url.trim();
}

export function getIndexName(config: ConnectionConfig): string {
  const prefix = config.indexPrefix.trim();
  return prefix.endsWith('bookmarks') ? prefix : `${prefix}bookmarks`;
}

export function getProfileKey(config: ConnectionConfig): string {
  return `${config.esUrl.trim()}|${getIndexName(config)}`;
}

export function makeId(): string {
  return crypto.randomUUID();
}
