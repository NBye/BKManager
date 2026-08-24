import './styles.css';
import { createFolder, deleteSubtree, loadNodes, moveNode, requireConfig, syncNow, updateNode } from './app';
import { CONFIG_KEY, getConfig } from './config';
import { getNodes } from './db';
import { saveLocalNode } from './sync';
import type { BackupFile, BookmarkNode } from './types';
import { getProfileKey, now } from './types';
import { renderTree } from './tree';
import { showBookmarkDialog, showConfirmDialog, showTextDialog } from './ui';

const tree = document.querySelector<HTMLElement>('#tree')!;
const status = document.querySelector<HTMLElement>('#status')!;
let inlineEditFolderId: string | null = null;
let currentNodes: BookmarkNode[] = [];

function showStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function refresh(): Promise<void> {
  try {
    const config = await requireConfig();
    currentNodes = await loadNodes(config);
    await refreshView(config);
  } catch (error) {
    tree.innerHTML = '<div class="empty">请先配置 Elasticsearch 连接。</div>';
    showStatus(error instanceof Error ? error.message : '加载失败', true);
  }
}

async function refreshView(config: Awaited<ReturnType<typeof requireConfig>>): Promise<void> {
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
    onOpen: (node) => { if (node.nodeType === 'bookmark' && node.url) void chrome.tabs.create({ url: node.url }); },
    onEdit: async (node) => { await editNode(config, node); },
    onDelete: async (node) => {
      if (!await showConfirmDialog('删除收藏', `确定级联删除“${node.name ?? node.title ?? node.url}”吗？`, '确认删除')) return;
      const deletedIds = await deleteSubtree(config, node.id);
      const deleted = new Set(deletedIds);
      currentNodes = currentNodes.filter((item) => !deleted.has(item.id));
      await refreshView(config);
    }
  });
  showStatus(`目录 ${currentNodes.filter((node) => node.nodeType === 'folder').length} 个，收藏 ${currentNodes.filter((node) => node.nodeType === 'bookmark').length} 条`);
  void config;
}

async function editNode(config: Awaited<ReturnType<typeof requireConfig>>, node: BookmarkNode): Promise<void> {
  if (node.nodeType === 'folder') {
    const name = await showTextDialog('编辑目录', '目录名称', node.name ?? '未命名');
    if (name) {
      const updated = await updateNode(config, node, { name });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  } else {
    const result = await showBookmarkDialog(currentNodes, { url: node.url ?? '', title: node.title ?? '', iconUrl: node.iconUrl, folderId: node.parentId });
    if (result) {
      const updated = await updateNode(config, node, { title: result.title, url: result.url, parentId: result.folderId, iconUrl: result.iconUrl });
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
  const config = await requireConfig();
  const all = await getNodes(getProfileKey(config));
  downloadBackup({ format: 'bookmark-manager-backup', version: 1, exportedAt: new Date().toISOString(), nodes: all.filter((node) => !node.deletedAt) });
  showStatus('备份文件已导出');
}

async function importBackup(file: File): Promise<void> {
  const config = await requireConfig();
  const parsed = JSON.parse(await file.text()) as Partial<BackupFile>;
  if (parsed.format !== 'bookmark-manager-backup' || parsed.version !== 1 || !Array.isArray(parsed.nodes)) throw new Error('备份文件格式不正确。');
  const backupNodes = parsed.nodes as BookmarkNode[];
  const urls = new Set<string>();
  for (const node of backupNodes) {
    if (node.nodeType === 'bookmark') {
      const key = (node.urlKey ?? node.url ?? '').trim();
      if (!key || urls.has(key)) throw new Error(`备份中存在重复或无效 URL：${node.url ?? ''}`);
      urls.add(key);
    }
  }
  const profileKey = getProfileKey(config);
  const current = await getNodes(profileKey);
  const overwrite = await showConfirmDialog('恢复收藏备份', '确定使用备份覆盖本地和 ES 当前数据吗？取消后将进入合并模式。', '全量覆盖');
  const selected = new Map<string, BookmarkNode>();
  if (overwrite) {
    for (const node of current) await saveLocalNode(config, { ...node, deletedAt: now(), updatedAt: now() }, 'delete');
    for (const node of backupNodes) await saveLocalNode(config, { ...node, deletedAt: null, updatedAt: now() }, 'create');
  } else {
    for (const node of current) selected.set(node.nodeType === 'bookmark' ? `bookmark:${node.urlKey ?? node.url}` : `folder:${node.id}`, node);
    for (const node of backupNodes) {
      const key = node.nodeType === 'bookmark' ? `bookmark:${node.urlKey ?? node.url}` : `folder:${node.id}`;
      const existing = selected.get(key);
      if (existing && node.nodeType === 'bookmark' && !(await showConfirmDialog('URL 冲突', `${node.url}\n\n是否使用导入数据覆盖标题、图标和所属目录？`, '使用导入数据'))) continue;
      if (existing && node.nodeType === 'folder' && existing.updatedAt > node.updatedAt) continue;
      selected.set(key, { ...node, updatedAt: now(), deletedAt: null });
    }
    for (const node of selected.values()) await saveLocalNode(config, node, 'update');
  }
  await syncNow(config);
  await refresh();
  showStatus('备份已恢复并完成同步');
}

document.querySelector<HTMLButtonElement>('#settings')!.addEventListener('click', () => void chrome.runtime.openOptionsPage());
document.querySelector<HTMLButtonElement>('#sync')!.addEventListener('click', async () => { try { showStatus('同步中…'); await syncNow(await requireConfig()); await refresh(); } catch (error) { showStatus(error instanceof Error ? error.message : '同步失败', true); } });
document.querySelector<HTMLButtonElement>('#add-folder')!.addEventListener('click', async () => {
  const config = await requireConfig();
  const node = await createFolder(config, null, '未命名');
  currentNodes = [...currentNodes, node];
  inlineEditFolderId = node.id;
  await refreshView(config);
});
document.querySelector<HTMLButtonElement>('#export')!.addEventListener('click', () => void exportBackup().catch((error) => showStatus(error instanceof Error ? error.message : '导出失败', true)));
const importFile = document.querySelector<HTMLInputElement>('#import-file')!;
document.querySelector<HTMLButtonElement>('#import')!.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => { const file = importFile.files?.[0]; if (file) void importBackup(file).catch((error) => showStatus(error instanceof Error ? error.message : '导入失败', true)); });

void getConfig().then(refresh);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[CONFIG_KEY]) return;
  inlineEditFolderId = null;
  showStatus('ES 连接已切换，正在加载新数据…');
  void refresh();
});

if (new URLSearchParams(location.search).get('sync') === '1') {
  void requireConfig().then(syncNow).then(refresh).catch((error) => showStatus(error instanceof Error ? error.message : '同步失败', true));
}
