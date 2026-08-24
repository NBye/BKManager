import './styles.css';
import { createBookmark, createFolder, deleteSubtree, DuplicateBookmarkError, loadNodes, moveNode, requireConfig, updateNode } from './app';
import { getConfig, isConfigComplete, saveConfig } from './config';
import { testConnection } from './es';
import { renderTree } from './tree';
import { showBookmarkDialog, showConfirmDialog, showTextDialog } from './ui';
import type { BookmarkNode, ConnectionConfig } from './types';

const tree = document.querySelector<HTMLElement>('#tree')!;
const status = document.querySelector<HTMLElement>('#status')!;
const popupShell = document.querySelector<HTMLElement>('.popup-shell')!;
const configPanel = document.querySelector<HTMLElement>('#config-panel')!;
const inlineConfigForm = document.querySelector<HTMLFormElement>('#inline-config-form')!;
const inlineEsUrl = document.querySelector<HTMLInputElement>('#inline-es-url')!;
const inlineApiKey = document.querySelector<HTMLInputElement>('#inline-api-key')!;
const inlineIndexPrefix = document.querySelector<HTMLInputElement>('#inline-index-prefix')!;
const searchBar = document.querySelector<HTMLElement>('#search-bar')!;
const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
let selectedFolderId: string | null = null;
let inlineEditFolderId: string | null = null;
let currentNodes = [] as Awaited<ReturnType<typeof loadNodes>>;
let activeContextMenu: HTMLElement | null = null;

function showStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function readInlineConfig() {
  return {
    esUrl: inlineEsUrl.value.trim().replace(/\/$/, ''),
    apiKey: inlineApiKey.value.trim(),
    indexPrefix: inlineIndexPrefix.value.trim()
  };
}

function setConfiguredView(configured: boolean, config: ConnectionConfig | null = null): void {
  popupShell.classList.toggle('config-mode', !configured);
  configPanel.classList.toggle('hidden', configured);
  tree.classList.toggle('hidden', !configured);
  if (!configured) {
    searchBar.classList.add('hidden');
    for (const id of ['add-current', 'add-folder', 'search-toggle']) document.querySelector<HTMLElement>(`#${id}`)?.classList.add('hidden');
    if (config) {
      inlineEsUrl.value = config.esUrl ?? '';
      inlineApiKey.value = config.apiKey ?? '';
      inlineIndexPrefix.value = config.indexPrefix ?? '';
    }
    setTimeout(() => inlineEsUrl.focus(), 0);
  } else {
    for (const id of ['add-current', 'add-folder', 'search-toggle']) document.querySelector<HTMLElement>(`#${id}`)?.classList.remove('hidden');
  }
}

function closeContextMenu(): void {
  activeContextMenu?.remove();
  activeContextMenu = null;
}

async function editNode(node: BookmarkNode): Promise<void> {
  const config = await requireConfig();
  if (node.nodeType === 'folder') {
    const name = await showTextDialog('编辑目录', '目录名称', node.name ?? '未命名');
    if (name) await updateNode(config, node, { name });
  } else {
    const result = await showBookmarkDialog(currentNodes, {
      url: node.url ?? '',
      title: node.title ?? '',
      iconUrl: node.iconUrl,
      folderId: node.parentId
    });
    if (result) await updateNode(config, node, { title: result.title, url: result.url, iconUrl: result.iconUrl });
  }
  await refresh();
}

function showNodeContextMenu(node: BookmarkNode, event: MouseEvent): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'node-context-menu';
  const edit = document.createElement('button');
  edit.textContent = '编辑';
  edit.addEventListener('click', () => { closeContextMenu(); void editNode(node).catch((error) => showStatus(error instanceof Error ? error.message : '编辑失败', true)); });
  const remove = document.createElement('button');
  remove.textContent = '删除';
  remove.addEventListener('click', async () => {
    closeContextMenu();
    if (!await showConfirmDialog('删除收藏', `确定删除“${node.name ?? node.title ?? node.url}”吗？`, '确认删除')) return;
    try { await deleteSubtree(await requireConfig(), node.id); await refresh(); } catch (error) { showStatus(error instanceof Error ? error.message : '删除失败', true); }
  });
  menu.append(edit, remove);
  document.body.append(menu);
  const menuWidth = 92;
  menu.style.left = `${Math.min(event.clientX, Math.max(4, window.innerWidth - menuWidth))}px`;
  menu.style.top = `${Math.min(event.clientY, Math.max(4, window.innerHeight - 76))}px`;
  activeContextMenu = menu;
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function filteredNodes(): typeof currentNodes {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return currentNodes;
  const matches = new Set(currentNodes.filter((node) => [node.name, node.title, node.url].filter(Boolean).some((value) => value!.toLowerCase().includes(query))).map((node) => node.id));
  for (const node of currentNodes.filter((item) => matches.has(item.id))) {
    let parentId = node.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = currentNodes.find((item) => item.id === parentId);
      if (!parent) break;
      matches.add(parent.id);
      parentId = parent.parentId;
    }
  }
  return currentNodes.filter((node) => matches.has(node.id));
}

function renderCurrentTree(): void {
  renderTree(tree, filteredNodes(), {
    selectedId: selectedFolderId,
    inlineEditFolderId,
    onSelect: (node) => { if (node.nodeType === 'folder') { selectedFolderId = node.id; renderCurrentTree(); } },
    onInlineEdit: async (node, name) => {
      inlineEditFolderId = null;
      try { await updateNode(await requireConfig(), node, { name }); await refresh(); } catch (error) { showStatus(error instanceof Error ? error.message : '保存目录失败', true); }
    },
    onMove: async (draggedId, targetId, mode) => {
      try { await moveNode(await requireConfig(), draggedId, targetId, mode); await refresh(); } catch (error) { showStatus(error instanceof Error ? error.message : '移动失败', true); }
    },
    onContextMenu: showNodeContextMenu,
    onOpen: (node) => { if (node.nodeType === 'bookmark' && node.url) void chrome.tabs.create({ url: node.url }); }
  });
}

async function refresh(): Promise<void> {
  try {
    currentNodes = await loadNodes(await requireConfig());
    if (selectedFolderId && !currentNodes.some((node) => node.id === selectedFolderId && node.nodeType === 'folder')) selectedFolderId = null;
    renderCurrentTree();
    showStatus(`已加载 ${currentNodes.filter((node) => node.nodeType === 'bookmark').length} 条收藏`);
  } catch (error) {
    tree.innerHTML = '<div class="empty">请先配置 Elasticsearch 连接。</div>';
    showStatus(error instanceof Error ? error.message : '加载失败', true);
  }
}

async function addBookmark(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error('当前页面不是 HTTP 或 HTTPS 网页，不能收藏。');
    const config = await requireConfig();
    const result = await showBookmarkDialog(currentNodes, { url: tab.url, title: tab.title ?? tab.url, iconUrl: tab.favIconUrl, folderId: selectedFolderId });
    if (!result) return;
    try {
      await createBookmark(config, result.folderId, result.url, result.title, result.iconUrl);
    } catch (error) {
      if (!(error instanceof DuplicateBookmarkError)) throw error;
      const targetFolder = result.folderId ? currentNodes.find((node) => node.id === result.folderId)?.name ?? '选中文件夹' : '根目录';
      const shouldMove = await showConfirmDialog('地址已收藏', `${error.message}\n\n是否迁移到${targetFolder}，并更新标题和图标？`, '迁移收藏');
      if (!shouldMove) return;
      await updateNode(config, error.existing, { parentId: result.folderId, title: result.title, iconUrl: result.iconUrl });
    }
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : '收藏失败', true); }
}

async function addFolder(): Promise<void> {
  try {
    const config = await requireConfig();
    const node = await createFolder(config, selectedFolderId, '未命名');
    selectedFolderId = node.id;
    inlineEditFolderId = node.id;
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : '创建目录失败', true); }
}

document.querySelector<HTMLButtonElement>('#settings')!.addEventListener('click', () => void chrome.runtime.openOptionsPage());
document.querySelector<HTMLButtonElement>('#add-current')!.addEventListener('click', () => void addBookmark());
document.querySelector<HTMLButtonElement>('#add-folder')!.addEventListener('click', () => void addFolder());
document.querySelector<HTMLButtonElement>('#search-toggle')!.addEventListener('click', () => {
  searchBar.classList.toggle('hidden');
  if (!searchBar.classList.contains('hidden')) { searchInput.focus(); searchInput.select(); }
});
searchInput.addEventListener('input', () => renderCurrentTree());

document.querySelector<HTMLButtonElement>('#inline-config-test')!.addEventListener('click', async () => {
  try { await testConnection(readInlineConfig()); showStatus('ES 连接成功'); }
  catch (error) { showStatus(error instanceof Error ? error.message : '连接失败', true); }
});
inlineConfigForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const config = readInlineConfig();
    await saveConfig(config);
    await testConnection(config);
    setConfiguredView(true);
    showStatus('配置已保存，连接测试成功');
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : '保存失败', true); }
});

void getConfig().then((config) => {
  if (!isConfigComplete(config)) {
    setConfiguredView(false, config);
    showStatus('请先完成 ES 连接配置');
    return;
  }
  setConfiguredView(true);
  return refresh();
}).catch((error) => showStatus(error instanceof Error ? error.message : '加载失败', true));
