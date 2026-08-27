import { CONFIG_KEY, getConfig, isConfigComplete } from './config';
import { createText } from './app';
import { getOperations } from './db';
import { now } from './types';
import { cancelScheduledSyncs, scheduleSync } from './sync';
import { getProfileKey } from './types';

const RETRY_ALARM = 'bookmark-sync-retry';
const MAX_SYNC_ATTEMPTS = 8;

function ensureRetryAlarm(): void {
  void chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
}

function createContextMenus(): void {
  const create = (properties: chrome.contextMenus.CreateProperties): void => {
    chrome.contextMenus.create(properties, () => void chrome.runtime.lastError);
  };
  create({
      id: 'bookmark-page',
      title: '收藏到书签',
      contexts: ['page']
    });
    create({
      id: 'bookmark-link',
      title: '收藏链接到书签',
      contexts: ['link']
    });
    create({
      id: 'bookmark-text',
      title: '加入BKM收藏',
      contexts: ['selection']
    });
    create({
      id: 'open-manager',
      title: '打开收藏管理',
      contexts: ['action']
    });
    create({
      id: 'sync-now',
      title: '同步数据',
      contexts: ['action']
    });
    create({
      id: 'open-options',
      title: '插件设置',
      contexts: ['action']
    });
}

function showActionResult(message: string, error = false): void {
  void chrome.action.setBadgeText({ text: error ? '!' : '✓' });
  void chrome.action.setBadgeBackgroundColor({ color: error ? '#b42318' : '#16803c' });
  void new Promise((resolve) => setTimeout(resolve, 2500)).then(() => chrome.action.setBadgeText({ text: '' }));
}

ensureRetryAlarm();
createContextMenus();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[CONFIG_KEY]) cancelScheduledSyncs();
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'schedule-sync') return;
  void getConfig().then((config) => { if (isConfigComplete(config)) scheduleSync(config); });
});

chrome.runtime.onInstalled.addListener(() => {
  ensureRetryAlarm();
});

chrome.runtime.onStartup.addListener(ensureRetryAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM) return;
  void getConfig().then(async (config) => {
    if (!isConfigComplete(config)) return;
    const operations = await getOperations(getProfileKey(config));
    if (operations.some((operation) => operation.attempts < MAX_SYNC_ATTEMPTS && (operation.nextRetryAt ?? 0) <= now())) scheduleSync(config);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'bookmark-text') {
    const content = info.selectionText;
    if (!content?.trim()) return;
    void getConfig()
      .then((storedConfig) => createText(isConfigComplete(storedConfig) ? storedConfig : null, null, content))
      .then(() => showActionResult('已加入 BKM 收藏'))
      .catch((error) => showActionResult(error instanceof Error ? error.message : '加入收藏失败', true));
    return;
  }
  if (info.menuItemId === 'open-manager') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html') });
    return;
  }
  if (info.menuItemId === 'open-options') {
    void chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === 'sync-now') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html?sync=1') });
    return;
  }
  if (info.menuItemId !== 'bookmark-page' && info.menuItemId !== 'bookmark-link') return;
  const url = info.menuItemId === 'bookmark-link' ? info.linkUrl : tab?.url;
  if (!url || !/^https?:\/\//i.test(url)) return;
  const title = info.menuItemId === 'bookmark-link' ? info.linkUrl : (tab?.title ?? url);
  const params = new URLSearchParams({ url, title: title ?? url });
  if (tab?.favIconUrl) params.set('iconUrl', tab.favIconUrl);
  void chrome.windows.create({
    url: chrome.runtime.getURL(`src/capture.html?${params.toString()}`),
    type: 'popup',
    width: 430,
    height: 460
  });
});
