import type { ConnectionConfig } from './types';

export const CONFIG_KEY = 'connectionConfig';
export const OFFLINE_MODE_KEY = 'offlineMode';

export function normalizeConfig(config: ConnectionConfig): ConnectionConfig {
  return {
    esUrl: config.esUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    indexPrefix: config.indexPrefix.trim(),
    ...(config.profileId ? { profileId: config.profileId.trim() } : {})
  };
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validateConfig(config: ConnectionConfig): void {
  let url: URL;
  try { url = new URL(config.esUrl); } catch { throw new Error('ES 地址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ES 地址只支持 HTTP 或 HTTPS。');
  if (url.protocol !== 'https:' && !isLocalHost(url.hostname)) throw new Error('生产环境必须使用 HTTPS 连接 ES；HTTP 仅允许 localhost 开发地址。');
  if (!config.apiKey.trim()) throw new Error('授权 Key 不能为空。');
  if (!config.indexPrefix.trim()) throw new Error('索引前缀不能为空。');
}

export async function ensureEsPermission(config: ConnectionConfig): Promise<void> {
  const url = new URL(config.esUrl);
  const origin = `${url.protocol}//${url.host}/*`;
  if (!chrome.permissions?.contains) return;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (granted) return;
  const requested = await chrome.permissions.request({ origins: [origin] });
  if (!requested) throw new Error('未授予 ES 主机访问权限，已保留本地离线数据。');
}

export async function getConfig(): Promise<ConnectionConfig | null> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  const config = (result[CONFIG_KEY] as ConnectionConfig | undefined) ?? null;
  return config ? normalizeConfig(config) : null;
}

export async function saveConfig(config: ConnectionConfig): Promise<void> {
  const next = normalizeConfig(config);
  validateConfig(next);
  const current = await getConfig();
  const sameProfile = current
    && current.esUrl === next.esUrl
    && current.apiKey === next.apiKey
    && current.indexPrefix === next.indexPrefix;
  const profileId = sameProfile ? current.profileId : crypto.randomUUID();
  await chrome.storage.local.set({ [CONFIG_KEY]: { ...next, profileId }, [OFFLINE_MODE_KEY]: false });
}

export async function getOfflineMode(): Promise<boolean> {
  const result = await chrome.storage.local.get(OFFLINE_MODE_KEY);
  return result[OFFLINE_MODE_KEY] === true;
}

export async function setOfflineMode(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [OFFLINE_MODE_KEY]: enabled });
}

export function isConfigComplete(config: ConnectionConfig | null): config is ConnectionConfig {
  if (!config?.esUrl.trim() || !config.apiKey.trim() || !config.indexPrefix.trim()) return false;
  try { validateConfig(config); return true; } catch { return false; }
}
