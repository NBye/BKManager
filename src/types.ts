export type NodeType = 'folder' | 'bookmark' | 'text';

export interface BookmarkNode {
  id: string;
  nodeType: NodeType;
  parentId: string | null;
  name?: string;
  url?: string;
  title?: string;
  iconUrl?: string;
  content?: string;
  urlKey?: string;
  sortOrder: number;
  createdAt?: number;
  updatedAt: number;
  revision?: number;
  updatedBy?: string;
  deletedAt?: number | null;
}

export interface ConnectionConfig {
  esUrl: string;
  apiKey: string;
  indexPrefix: string;
  profileId?: string;
}

export interface SyncOperation {
  id: string;
  profileKey: string;
  nodeId: string;
  action: 'create' | 'update' | 'delete';
  data: BookmarkNode;
  queuedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  nextRetryAt?: number;
  lastError?: string;
}

export interface SyncMeta {
  profileKey: string;
  lastSyncAt?: number;
  lastFullSyncAt?: number;
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
export const OFFLINE_PROFILE_KEY = 'offline-local';

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
  const legacyKey = `${config.esUrl.trim()}|${getIndexName(config)}`;
  return config.profileId ? `${legacyKey}|${config.profileId}` : legacyKey;
}

export function makeId(): string {
  return crypto.randomUUID();
}
