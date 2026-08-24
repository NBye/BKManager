import type { ConnectionConfig } from './types';

export const CONFIG_KEY = 'connectionConfig';

export function normalizeConfig(config: ConnectionConfig): ConnectionConfig {
  return {
    esUrl: config.esUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    indexPrefix: config.indexPrefix.trim()
  };
}

export async function getConfig(): Promise<ConnectionConfig | null> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  const config = (result[CONFIG_KEY] as ConnectionConfig | undefined) ?? null;
  return config ? normalizeConfig(config) : null;
}

export async function saveConfig(config: ConnectionConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: normalizeConfig(config) });
}

export function isConfigComplete(config: ConnectionConfig | null): config is ConnectionConfig {
  return Boolean(config?.esUrl.trim() && config.apiKey.trim() && config.indexPrefix.trim());
}
