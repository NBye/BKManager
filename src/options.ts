import './styles.css';
import { syncNow } from './app';
import { getConfig, normalizeConfig, saveConfig } from './config';
import { testConnection } from './es';
import type { ConnectionConfig } from './types';

const form = document.querySelector<HTMLFormElement>('#form')!;
const esUrl = document.querySelector<HTMLInputElement>('#es-url')!;
const apiKey = document.querySelector<HTMLInputElement>('#api-key')!;
const indexPrefix = document.querySelector<HTMLInputElement>('#index-prefix')!;
const status = document.querySelector<HTMLElement>('#status')!;

function showStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function readConfig(): ConnectionConfig {
  return normalizeConfig({ esUrl: esUrl.value, apiKey: apiKey.value, indexPrefix: indexPrefix.value });
}

void getConfig().then((config) => {
  if (!config) return;
  esUrl.value = config.esUrl;
  apiKey.value = config.apiKey;
  indexPrefix.value = config.indexPrefix;
});

document.querySelector<HTMLButtonElement>('#test')!.addEventListener('click', async () => {
  try { await testConnection(readConfig()); showStatus('ES 连接成功'); } catch (error) { showStatus(error instanceof Error ? error.message : '连接失败', true); }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const config = readConfig();
    showStatus('正在验证并切换 ES 连接…');
    await testConnection(config);
    await syncNow(config);
    await saveConfig(config);
    showStatus('配置已保存，连接测试成功');
    setTimeout(async () => {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
      else window.close();
    }, 250);
  } catch (error) { showStatus(error instanceof Error ? error.message : '保存失败', true); }
});
