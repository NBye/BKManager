import type { ConnectionConfig } from './types';

const CONFIG_KEY = 'connectionConfig';

export async function getConfig(): Promise<ConnectionConfig | null> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return (result[CONFIG_KEY] as ConnectionConfig | undefined) ?? null;
}

export async function saveConfig(config: ConnectionConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

export function isConfigComplete(config: ConnectionConfig | null): config is ConnectionConfig {
  return Boolean(config?.esUrl.trim() && config.apiKey.trim() && config.indexPrefix.trim());
}
