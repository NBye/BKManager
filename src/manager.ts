import './styles.css';
import { createFolder, deleteSubtree, loadNodes, moveNode, persistNodes, syncNow, updateNode } from './app';
import { CONFIG_KEY, getConfig, isConfigComplete, saveConfig } from './config';
import { configFromFields, parseConfigJson, serializeConfig, writeConfigFields } from './config-editor';
import { getNodes } from './db';
import { clearOfflineProfile, getStorageProfileKey, migrateOfflineProfile } from './sync';
import type { BackupFile, BookmarkNode, ConnectionConfig } from './types';
import { getIndexName, now } from './types';
import { fetchAllNodes, testConnection } from './es';
import { parseBackup } from './nodes';
import { renderTree } from './tree';
import { showBookmarkDialog, showConfirmDialog, showTextContentDialog, showTextDialog, showToast } from './ui';
import { copyNode, getNodeTitle } from './node-service';

const tree = document.querySelector<HTMLElement>('#tree')!;
const status = document.querySelector<HTMLElement>('#status')!;
const settingsStatus = document.querySelector<HTMLElement>('#settings-status')!;
const managerView = document.querySelector<HTMLElement>('#manager-view')!;
const settingsView = document.querySelector<HTMLElement>('#settings-view')!;
const sidebarProfile = document.querySelector<HTMLElement>('#sidebar-profile')!;
const settingsForm = document.querySelector<HTMLFormElement>('#form')!;
const esUrl = document.querySelector<HTMLInputElement>('#es-url')!;
const apiKey = document.querySelector<HTMLInputElement>('#api-key')!;
const indexPrefix = document.querySelector<HTMLInputElement>('#index-prefix')!;
const formFields = document.querySelector<HTMLElement>('#form-fields')!;
const jsonField = document.querySelector<HTMLElement>('#json-field')!;
const configJson = document.querySelector<HTMLTextAreaElement>('#config-json')!;
const formMode = document.querySelector<HTMLButtonElement>('#form-mode')!;
const jsonMode = document.querySelector<HTMLButtonElement>('#json-mode')!;
let settingsMode: 'form' | 'json' = 'form';
let inlineEditFolderId: string | null = null;
let currentNodes: BookmarkNode[] = [];

async function getActiveConfig(): Promise<ConnectionConfig | null> {
  const config = await getConfig();
  return isConfigComplete(config) ? config : null;
}

function showSettingsStatus(message: string, error = false): void {
  settingsStatus.textContent = message;
  settingsStatus.classList.toggle('error', error);
}

function configFromForm() {
  return configFromFields({ esUrl, apiKey, indexPrefix });
}

function writeConfigJson(): void {
  configJson.value = serializeConfig(configFromForm());
}

function configFromJson() {
  return parseConfigJson(configJson.value);
}

function readSettingsConfig() { return settingsMode === 'json' ? configFromJson() : configFromForm(); }

function fillSettings(config: Awaited<ReturnType<typeof getConfig>>): void {
  writeConfigFields({ esUrl, apiKey, indexPrefix }, config);
  writeConfigJson();
  sidebarProfile.textContent = config ? getIndexName(config) : '未配置';
}

function setSettingsMode(mode: 'form' | 'json'): void {
  settingsMode = mode;
  formFields.classList.toggle('hidden', mode !== 'form');
  jsonField.classList.toggle('hidden', mode !== 'json');
  formFields.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = mode !== 'form'; });
  formMode.classList.toggle('active', mode === 'form');
  jsonMode.classList.toggle('active', mode === 'json');
  if (mode === 'json') writeConfigJson();
}

function syncFormToJson(): void { writeConfigJson(); }

function syncJsonToForm(): void {
  try {
    const config = configFromJson();
    esUrl.value = config.esUrl;
    apiKey.value = config.apiKey;
    indexPrefix.value = config.indexPrefix;
  } catch {
    return;
  }
}

function showView(view: 'manager' | 'settings'): void {
  managerView.classList.toggle('hidden', view !== 'manager');
  settingsView.classList.toggle('hidden', view !== 'settings');
  document.querySelector('#nav-manager')?.classList.toggle('active', view === 'manager');
  document.querySelector('#nav-settings')?.classList.toggle('active', view === 'settings');
}

function showStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function refresh(): Promise<void> {
  try {
    const config = await getActiveConfig();
    currentNodes = await loadNodes(config);
    await refreshView(config);
  } catch (error) {
    tree.innerHTML = '<div class="empty">请先配置 Elasticsearch 连接。</div>';
    showStatus(error instanceof Error ? error.message : '加载失败', true);
  }
}

async function refreshView(config: ConnectionConfig | null): Promise<void> {
  renderTree(tree, currentNodes, {
    showActions: true,
    showDate: true,
    inlineEditFolderId,
    onAddFolder: async (parent) => {
      const node = await createFolder(config, parent.id, '未命名');
      currentNodes = [...currentNodes, node];
      inlineEditFolderId = node.id;
      await refreshView(config);
    },
    onInlineEdit: async (node, name) => {
      inlineEditFolderId = null;
      const updated = await updateNode(config, node, { name });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
      await refreshView(config);
    },
    onMove: async (draggedId, targetId, mode) => {
      const moved = await moveNode(config, draggedId, targetId, mode);
      const movedById = new Map(moved.map((item) => [item.id, item]));
      currentNodes = currentNodes.map((item) => movedById.get(item.id) ?? item);
      await refreshView(config);
    },
    onOpen: (node) => {
      if (node.nodeType === 'bookmark' && node.url) void chrome.tabs.create({ url: node.url });
      if (node.nodeType === 'text') void copyNode(node).then(() => showToast('文案已复制')).catch((error) => showToast(error instanceof Error ? error.message : '复制失败', true));
    },
    onEdit: async (node) => { await editNode(config, node); },
    onDelete: async (node) => {
      if (!await showConfirmDialog('删除收藏', `确定级联删除“${getNodeTitle(node)}”吗？`, '确认删除')) return;
      const deletedIds = await deleteSubtree(config, node.id);
      const deleted = new Set(deletedIds);
      currentNodes = currentNodes.filter((item) => !deleted.has(item.id));
      await refreshView(config);
    }
  });
  showStatus(config ? `目录 ${currentNodes.filter((node) => node.nodeType === 'folder').length} 个，收藏 ${currentNodes.filter((node) => node.nodeType !== 'folder').length} 条` : `离线模式 · 目录 ${currentNodes.filter((node) => node.nodeType === 'folder').length} 个，收藏 ${currentNodes.filter((node) => node.nodeType !== 'folder').length} 条`);
}

async function editNode(config: ConnectionConfig | null, node: BookmarkNode): Promise<void> {
  if (node.nodeType === 'folder') {
    const name = await showTextDialog('编辑目录', '目录名称', node.name ?? '未命名');
    if (name) {
      const updated = await updateNode(config, node, { name });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  } else if (node.nodeType === 'bookmark') {
    const result = await showBookmarkDialog(currentNodes, { url: node.url ?? '', title: node.title ?? '', iconUrl: node.iconUrl, folderId: node.parentId });
    if (result) {
      const updated = await updateNode(config, node, { title: result.title, url: result.url, parentId: result.folderId, iconUrl: result.iconUrl });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  } else {
    const content = await showTextContentDialog('编辑文案', node.content ?? '');
    if (content !== null) {
      const updated = await updateNode(config, node, { content });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  }
  await refreshView(config);
}

function downloadBackup(backup: BackupFile): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bookmark-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportBackup(): Promise<void> {
  const config = await getActiveConfig();
  const all = await getNodes(getStorageProfileKey(config));
  downloadBackup({ format: 'bookmark-manager-backup', version: 1, exportedAt: new Date().toISOString(), nodes: all.filter((node) => !node.deletedAt) });
  showStatus('备份文件已导出');
}

async function importBackup(file: File): Promise<void> {
  const config = await getActiveConfig();
  const parsedValue: unknown = JSON.parse(await file.text());
  const parsed = parseBackup(parsedValue);
  if (parsed.errors.length) throw new Error(`备份校验失败：${parsed.errors.slice(0, 3).join('；')}`);
  const backupNodes = parsed.nodes;
  const urls = new Set<string>();
  for (const node of backupNodes) {
    if (node.nodeType === 'bookmark') {
      const key = (node.urlKey ?? node.url ?? '').trim();
      if (!key || urls.has(key)) throw new Error(`备份中存在重复或无效 URL：${node.url ?? ''}`);
      urls.add(key);
    } else if (node.nodeType === 'text' && !node.content?.trim()) {
      throw new Error('备份中存在空文案。');
    }
  }
  const profileKey = getStorageProfileKey(config);
  if (config) await syncNow(config);
  const current = await getNodes(profileKey);
  const remote = config ? await fetchAllNodes(config) : [];
  const overwrite = await showConfirmDialog('恢复收藏备份', '确定使用备份覆盖本地和 ES 当前数据吗？取消后将进入合并模式。', '全量覆盖');
  const selected = new Map<string, BookmarkNode>();
  if (overwrite) {
    const allCurrent = new Map([...current, ...remote].map((node) => [node.id, node]));
    await persistNodes(config, [
      ...[...allCurrent.values()].map((node) => ({ node: { ...node, deletedAt: now(), updatedAt: now() }, action: 'delete' as const })),
      ...backupNodes.map((node) => ({ node: { ...node, deletedAt: null, updatedAt: now() }, action: 'create' as const }))
    ]);
  } else {
    for (const node of current) selected.set(node.nodeType === 'bookmark' ? `bookmark:${node.urlKey ?? node.url}` : `${node.nodeType}:${node.id}`, node);
    for (const node of backupNodes) {
      const key = node.nodeType === 'bookmark' ? `bookmark:${node.urlKey ?? node.url}` : `${node.nodeType}:${node.id}`;
      const existing = selected.get(key);
      if (existing && node.nodeType === 'bookmark' && !(await showConfirmDialog('URL 冲突', `${node.url}\n\n是否使用导入数据覆盖标题、图标和所属目录？`, '使用导入数据'))) continue;
      if (existing && node.nodeType !== 'bookmark' && existing.updatedAt > node.updatedAt) continue;
      selected.set(key, { ...node, updatedAt: now(), deletedAt: null });
    }
    await persistNodes(config, [...selected.values()].map((node) => ({ node, action: 'update' as const })));
  }
  if (config) await syncNow(config);
  await refresh();
  showStatus(config ? '备份已恢复并完成同步' : '备份已恢复到本地离线数据');
}

document.querySelector<HTMLButtonElement>('#nav-manager')!.addEventListener('click', () => showView('manager'));
document.querySelector<HTMLButtonElement>('#nav-settings')!.addEventListener('click', () => showView('settings'));
document.querySelector<HTMLButtonElement>('#sync')!.addEventListener('click', async () => { try { const config = await getActiveConfig(); if (!config) { showStatus('当前为离线模式，配置 ES 后才能同步'); return; } showStatus('全量校准同步中…'); await syncNow(config, true); await refresh(); } catch (error) { showStatus(error instanceof Error ? error.message : '同步失败', true); } });
document.querySelector<HTMLButtonElement>('#add-folder')!.addEventListener('click', async () => {
  const config = await getActiveConfig();
  const node = await createFolder(config, null, '未命名');
  currentNodes = [...currentNodes, node];
  inlineEditFolderId = node.id;
  await refreshView(config);
});
document.querySelector<HTMLButtonElement>('#export')!.addEventListener('click', () => void exportBackup().catch((error) => showStatus(error instanceof Error ? error.message : '导出失败', true)));
const importFile = document.querySelector<HTMLInputElement>('#import-file')!;
document.querySelector<HTMLButtonElement>('#import')!.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => { const file = importFile.files?.[0]; if (file) void importBackup(file).catch((error) => showStatus(error instanceof Error ? error.message : '导入失败', true)); });

formMode.addEventListener('click', () => setSettingsMode('form'));
jsonMode.addEventListener('click', () => setSettingsMode('json'));
for (const input of [esUrl, apiKey, indexPrefix]) input.addEventListener('input', syncFormToJson);
configJson.addEventListener('input', syncJsonToForm);
document.querySelector<HTMLButtonElement>('#test')!.addEventListener('click', async () => {
  try { await testConnection(readSettingsConfig()); showSettingsStatus('ES 连接成功'); }
  catch (error) { showSettingsStatus(error instanceof Error ? error.message : '连接失败', true); }
});
settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const config = readSettingsConfig();
    showSettingsStatus('正在验证并切换 ES 连接…');
    await testConnection(config);
    await saveConfig(config);
    const savedConfig = await getConfig();
    if (!savedConfig) throw new Error('配置保存失败。');
    const migratedOfflineData = await migrateOfflineProfile(savedConfig);
    await syncNow(savedConfig);
    if (migratedOfflineData) await clearOfflineProfile();
    fillSettings(savedConfig);
    showSettingsStatus('配置已保存，连接测试成功');
    showView('manager');
    await refresh();
  } catch (error) { showSettingsStatus(error instanceof Error ? error.message : '保存失败', true); }
});

void getConfig().then((config) => {
  fillSettings(config);
  if (new URLSearchParams(location.search).get('view') === 'settings') showView('settings');
  return refresh();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[CONFIG_KEY]) return;
  inlineEditFolderId = null;
  showStatus('ES 连接已切换，正在加载新数据…');
  void getConfig().then(fillSettings);
  void refresh();
});

if (new URLSearchParams(location.search).get('sync') === '1') {
  void getActiveConfig().then((config) => { if (!config) throw new Error('请先配置 Elasticsearch 连接。'); return syncNow(config); }).then(refresh).catch((error) => showStatus(error instanceof Error ? error.message : '同步失败', true));
}
