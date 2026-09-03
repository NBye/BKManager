import './styles.css';
import { createBookmark, createFolder, createText, deleteSubtree, DuplicateBookmarkError, loadNodes, moveNode, moveNodeUp, syncNow, updateNode } from './app';
import { CONFIG_KEY, getConfig, getOfflineMode, isConfigComplete, saveConfig, setOfflineMode } from './config';
import { configFromFields, parseConfigJson, serializeConfig, writeConfigFields } from './config-editor';
import { testConnection } from './es';
import { bindProfile } from './sync';
import { renderTree } from './tree';
import { showBookmarkDialog, showConfirmDialog, showCreateDialog, showFolderDialog, showTextContentDialog, showToast as showSharedToast } from './ui';
import type { BookmarkNode, ConnectionConfig } from './types';
import { copyNode } from './node-service';

const tree = document.querySelector<HTMLElement>('#tree')!;
const treeScroll = document.querySelector<HTMLElement>('#tree-scroll')!;
const status = document.querySelector<HTMLElement>('#status')!;
const popupShell = document.querySelector<HTMLElement>('.popup-shell')!;
const configPanel = document.querySelector<HTMLElement>('#config-panel')!;
const inlineConfigForm = document.querySelector<HTMLFormElement>('#inline-config-form')!;
const inlineEsUrl = document.querySelector<HTMLInputElement>('#inline-es-url')!;
const inlineApiKey = document.querySelector<HTMLInputElement>('#inline-api-key')!;
const inlineIndexPrefix = document.querySelector<HTMLInputElement>('#inline-index-prefix')!;
const inlineFormFields = document.querySelector<HTMLElement>('#inline-form-fields')!;
const inlineJsonField = document.querySelector<HTMLElement>('#inline-json-field')!;
const inlineConfigJson = document.querySelector<HTMLTextAreaElement>('#inline-config-json')!;
const inlineFormMode = document.querySelector<HTMLButtonElement>('#inline-form-mode')!;
const inlineJsonMode = document.querySelector<HTMLButtonElement>('#inline-json-mode')!;
const inlineOffline = document.querySelector<HTMLButtonElement>('#inline-offline')!;
const searchBar = document.querySelector<HTMLElement>('#search-bar')!;
const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
const layoutToggle = document.querySelector<HTMLButtonElement>('#layout-toggle')!;
const layoutTreeIcon = document.querySelector<HTMLElement>('#layout-tree-icon')!;
const layoutFlatIcon = document.querySelector<HTMLElement>('#layout-flat-icon')!;
type PopupLayout = 'tree' | 'flat';
let layout: PopupLayout = localStorage.getItem('popup-layout') === 'flat' ? 'flat' : 'tree';
let flatFolderId: string | null = null;
let selectedFolderId: string | null = null;
let inlineEditFolderId: string | null = null;
let currentNodes = [] as Awaited<ReturnType<typeof loadNodes>>;
let activeContextMenu: HTMLElement | null = null;
let inlineConfigMode: 'form' | 'json' = 'form';
let activeConfig: ConnectionConfig | null = null;
let offlineMode = false;

function updateLayoutToggle(): void {
  const isTree = layout === 'tree';
  layoutTreeIcon.classList.toggle('hidden', !isTree);
  layoutFlatIcon.classList.toggle('hidden', isTree);
  layoutToggle.title = isTree ? '切换到宫格布局' : '切换到树状布局';
  layoutToggle.setAttribute('aria-label', isTree ? '切换到宫格布局' : '切换到树状布局');
}

function showStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
  status.classList.remove('flat-breadcrumb');
}

function showToast(message: string, error = false): void {
  showSharedToast(message, error);
}

function readInlineConfig() {
  return inlineConfigMode === 'form'
    ? configFromFields({ esUrl: inlineEsUrl, apiKey: inlineApiKey, indexPrefix: inlineIndexPrefix })
    : parseConfigJson(inlineConfigJson.value);
}

function writeInlineConfigJson(): void {
  inlineConfigJson.value = serializeConfig(configFromFields({ esUrl: inlineEsUrl, apiKey: inlineApiKey, indexPrefix: inlineIndexPrefix }));
}

function syncInlineFormToJson(): void { writeInlineConfigJson(); }

function syncInlineJsonToForm(): void {
  try {
    const config = readInlineConfig();
    inlineEsUrl.value = config.esUrl;
    inlineApiKey.value = config.apiKey;
    inlineIndexPrefix.value = config.indexPrefix;
  } catch {
    return;
  }
}

function setInlineConfigMode(mode: 'form' | 'json'): void {
  inlineConfigMode = mode;
  inlineFormFields.classList.toggle('hidden', mode !== 'form');
  inlineJsonField.classList.toggle('hidden', mode !== 'json');
  inlineFormFields.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = mode !== 'form'; });
  inlineFormMode.classList.toggle('active', mode === 'form');
  inlineJsonMode.classList.toggle('active', mode === 'json');
  if (mode === 'json') writeInlineConfigJson();
}

function setConfiguredView(configured: boolean, config: ConnectionConfig | null = null): void {
  popupShell.classList.toggle('config-mode', !configured);
  configPanel.classList.toggle('hidden', configured);
  treeScroll.classList.toggle('hidden', !configured);
  if (!configured) {
    searchBar.classList.add('hidden');
    for (const id of ['add-current', 'add-folder', 'search-toggle', 'layout-toggle']) document.querySelector<HTMLElement>(`#${id}`)?.classList.add('hidden');
    if (config) {
      writeConfigFields({ esUrl: inlineEsUrl, apiKey: inlineApiKey, indexPrefix: inlineIndexPrefix }, config);
      writeInlineConfigJson();
    }
    setTimeout(() => inlineEsUrl.focus(), 0);
  } else {
    for (const id of ['add-current', 'add-folder', 'search-toggle', 'layout-toggle']) document.querySelector<HTMLElement>(`#${id}`)?.classList.remove('hidden');
  }
}

function closeContextMenu(): void {
  activeContextMenu?.remove();
  activeContextMenu = null;
}

async function editNode(node: BookmarkNode): Promise<void> {
  const config = activeConfig;
  if (node.nodeType === 'folder') {
    const result = await showFolderDialog('编辑目录', currentNodes, { name: node.name ?? '未命名', folderId: node.parentId }, node.id);
    if (result) {
      const updated = await updateNode(config, node, { name: result.name, parentId: result.folderId });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  } else if (node.nodeType === 'bookmark') {
    const result = await showBookmarkDialog(currentNodes, {
      url: node.url ?? '',
      title: node.title ?? '',
      iconUrl: node.iconUrl,
      folderId: node.parentId
    });
    if (result) {
      const updated = await updateNode(config, node, { title: result.title, url: result.url, iconUrl: result.iconUrl, parentId: result.folderId });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  } else {
    const result = await showTextContentDialog('编辑文案', currentNodes, { title: node.title ?? '', content: node.content ?? '', folderId: node.parentId });
    if (result !== null) {
      const updated = await updateNode(config, node, { title: result.title, content: result.content, parentId: result.folderId });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  }
  renderCurrentTree();
}

async function createNodeInFolder(folderId: string | null): Promise<void> {
  const result = await showCreateDialog(currentNodes, folderId);
  if (!result) return;
  if (result.nodeType === 'folder') {
    const created = await createFolder(activeConfig, result.folderId, result.name);
    currentNodes = [...currentNodes, created];
  } else if (result.nodeType === 'text') {
    const created = await createText(activeConfig, result.folderId, result.content, result.title);
    currentNodes = [...currentNodes, created];
  } else {
    try {
      const created = await createBookmark(activeConfig, result.data.folderId, result.data.url, result.data.title, result.data.iconUrl);
      currentNodes = [...currentNodes, created];
    } catch (error) {
      if (!(error instanceof DuplicateBookmarkError)) throw error;
      const targetFolder = result.data.folderId ? currentNodes.find((node) => node.id === result.data.folderId)?.name ?? '选中文件夹' : '根目录';
      const shouldMove = await showConfirmDialog('地址已收藏', `${error.message}\n\n是否迁移到${targetFolder}，并更新标题和图标？`, '迁移收藏');
      if (!shouldMove) return;
      const updated = await updateNode(activeConfig, error.existing, { parentId: result.data.folderId, title: result.data.title, iconUrl: result.data.iconUrl });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
  }
  renderCurrentTree();
}

function showTreeContextMenu(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('.tree-row, .flat-item-card')) return;
  event.preventDefault();
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'node-context-menu';
  const create = document.createElement('button');
  create.type = 'button';
  create.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>新建</span>';
  create.addEventListener('click', () => {
    closeContextMenu();
    void createNodeInFolder(currentFolderId()).catch((error) => showStatus(error instanceof Error ? error.message : '新建失败', true));
  });
  menu.append(create);
  document.body.append(menu);
  const menuWidth = 92;
  menu.style.left = `${Math.min(event.clientX, Math.max(4, window.innerWidth - menuWidth))}px`;
  menu.style.top = `${Math.min(event.clientY, Math.max(4, window.innerHeight - 42))}px`;
  activeContextMenu = menu;
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

async function copyTextNode(node: BookmarkNode): Promise<void> {
  try {
    await copyNode(node);
    showToast('文案已复制');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '复制失败', true);
  }
}

function showNodeContextMenu(node: BookmarkNode, event: MouseEvent): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'node-context-menu';
  const createAction = (label: string, path: string): HTMLButtonElement => {
    const action = document.createElement('button');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute('d', path);
    icon.append(iconPath);
    action.append(icon, document.createTextNode(label));
    return action;
  };
  const edit = createAction('编辑', 'm4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm10.5-12.5 3 3');
  edit.addEventListener('click', () => { closeContextMenu(); void editNode(node).catch((error) => showStatus(error instanceof Error ? error.message : '编辑失败', true)); });
  if (node.nodeType === 'folder') {
    const create = createAction('新建', 'M12 5v14M5 12h14');
    create.addEventListener('click', () => { closeContextMenu(); void createNodeInFolder(node.id).catch((error) => showStatus(error instanceof Error ? error.message : '新建失败', true)); });
    menu.append(create);
  }
  const moveUp = createAction('上移', 'M12 19V5m0 0-5 5m5-5 5 5');
  moveUp.disabled = !node.parentId;
  moveUp.title = node.parentId ? '移入上一级目录' : '根目录节点不能上移';
  moveUp.addEventListener('click', async () => {
    closeContextMenu();
    try {
      const moved = await moveNodeUp(activeConfig, node.id);
      if (!moved.length) return;
      const movedById = new Map(moved.map((item) => [item.id, item]));
      currentNodes = currentNodes.map((item) => movedById.get(item.id) ?? item);
      renderCurrentTree();
    } catch (error) { showStatus(error instanceof Error ? error.message : '上移失败', true); }
  });
  const remove = createAction('删除', 'M5 7h14m-9 4v6m4-6v6M9 7V5h6v2m-8 0 1 13h8l1-13');
  remove.addEventListener('click', async () => {
    closeContextMenu();
    if (!await showConfirmDialog('删除收藏', `确定删除“${node.name ?? node.title ?? node.url}”吗？`, '确认删除')) return;
    try {
      const deletedIds = await deleteSubtree(activeConfig, node.id);
      const deleted = new Set(deletedIds);
      currentNodes = currentNodes.filter((item) => !deleted.has(item.id));
      if (selectedFolderId && deleted.has(selectedFolderId)) selectedFolderId = null;
      if (flatFolderId && deleted.has(flatFolderId)) flatFolderId = null;
      renderCurrentTree();
      if (activeConfig && !offlineMode) {
        void syncNow(activeConfig).catch((error) => showToast(error instanceof Error ? `同步失败，已保留本地修改：${error.message}` : '同步失败，已保留本地修改', true));
      }
    } catch (error) { showStatus(error instanceof Error ? error.message : '删除失败', true); }
  });
  menu.append(edit, moveUp, remove);
  document.body.append(menu);
  const menuWidth = 92;
  menu.style.left = `${Math.min(event.clientX, Math.max(4, window.innerWidth - menuWidth))}px`;
  menu.style.top = `${Math.min(event.clientY, Math.max(4, window.innerHeight - 110))}px`;
  activeContextMenu = menu;
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function filteredNodes(): typeof currentNodes {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return currentNodes;
  const matches = new Set(currentNodes.filter((node) => [node.name, node.title, node.url, node.content].filter(Boolean).some((value) => value!.toLowerCase().includes(query))).map((node) => node.id));
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

function folderPath(folderId: string | null): BookmarkNode[] {
  const path: BookmarkNode[] = [];
  const visited = new Set<string>();
  let currentId = folderId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = currentNodes.find((node) => node.id === currentId && node.nodeType === 'folder');
    if (!folder) break;
    path.unshift(folder);
    currentId = folder.parentId;
  }
  return path;
}

function currentFolderId(): string | null {
  return layout === 'flat' ? flatFolderId : selectedFolderId;
}

async function moveCurrentNode(draggedId: string, targetId: string, mode: 'before' | 'after' | 'inside'): Promise<void> {
  try {
    const moved = await moveNode(activeConfig, draggedId, targetId, mode);
    const movedById = new Map(moved.map((item) => [item.id, item]));
    currentNodes = currentNodes.map((item) => movedById.get(item.id) ?? item);
    renderCurrentTree();
  } catch (error) { showStatus(error instanceof Error ? error.message : '移动失败', true); }
}

function renderFlat(): void {
  status.replaceChildren();
  status.classList.remove('error');
  status.classList.add('flat-breadcrumb');
  const path = folderPath(flatFolderId);
  const root = document.createElement('button');
  root.className = 'flat-path-link';
  root.textContent = '全部';
  root.addEventListener('click', () => { flatFolderId = null; renderCurrentTree(); });
  status.append(root);
  for (const folder of path) {
    const separator = document.createElement('span');
    separator.textContent = '/';
    status.append(separator);
    const link = document.createElement('button');
    link.className = 'flat-path-link';
    link.textContent = folder.name ?? '未命名目录';
    link.addEventListener('click', () => { flatFolderId = folder.id; renderCurrentTree(); });
    status.append(link);
  }
  const visible = searchInput.value.trim() ? filteredNodes() : currentNodes.filter((node) => node.parentId === flatFolderId).sort((a, b) => a.sortOrder - b.sortOrder);
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = searchInput.value.trim() ? '没有匹配的收藏' : '此文件夹为空';
    tree.append(empty);
    return;
  }
  const itemGrid = document.createElement('div');
  itemGrid.className = 'flat-item-grid';
  for (const node of visible) {
    const card = document.createElement('div');
    card.className = `flat-item-card ${node.nodeType}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.draggable = true;
    card.dataset.nodeId = node.id;
    const icon = document.createElement('span');
    icon.className = 'flat-item-icon';
    if (node.nodeType === 'bookmark' && node.iconUrl) {
      const image = document.createElement('img');
      image.src = node.iconUrl;
      image.alt = '';
      image.onerror = () => { image.replaceWith(document.createTextNode('🔗')); };
      icon.append(image);
    } else if (node.nodeType === 'folder') icon.textContent = '📁';
    else if (node.nodeType === 'text') {
      const textIcon = Array.from(node.title ?? '').slice(0, 4);
      if (!textIcon.length) textIcon.push('📝');
      for (const character of textIcon) {
        const characterCell = document.createElement('span');
        characterCell.textContent = character;
        icon.append(characterCell);
      }
    }
    else icon.textContent = '🔗';
    const label = document.createElement('span');
    label.className = 'flat-item-label';
    label.textContent = node.nodeType === 'folder' ? node.name ?? '未命名目录' : node.title ?? node.url ?? '未命名收藏';
    label.title = label.textContent;
    card.append(icon, label);
    if (node.nodeType === 'folder') {
      const detail = document.createElement('span');
      detail.className = 'flat-item-detail';
      detail.textContent = `${currentNodes.filter((item) => item.parentId === node.id).length} 项`;
      card.append(detail);
    }
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', node.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drag-over');
      const draggedId = event.dataTransfer?.getData('text/plain');
      if (!draggedId || draggedId === node.id) return;
      const bounds = card.getBoundingClientRect();
      const offset = event.clientY - bounds.top;
      const mode = node.nodeType === 'folder' && offset >= bounds.height * 0.25 && offset <= bounds.height * 0.75
        ? 'inside'
        : offset < bounds.height / 2 ? 'before' : 'after';
      void moveCurrentNode(draggedId, node.id, mode);
    });
    card.addEventListener('contextmenu', (event) => { event.preventDefault(); showNodeContextMenu(node, event); });
    card.addEventListener('click', () => {
      if (node.nodeType === 'bookmark' && node.url) void chrome.tabs.create({ url: node.url });
      if (node.nodeType === 'text') void copyTextNode(node);
    });
    card.addEventListener('dblclick', () => { if (node.nodeType === 'folder') { flatFolderId = node.id; renderCurrentTree(); } });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (node.nodeType === 'folder') { flatFolderId = node.id; renderCurrentTree(); }
      else if (node.nodeType === 'bookmark' && node.url) void chrome.tabs.create({ url: node.url });
      else if (node.nodeType === 'text') void copyTextNode(node);
    });
    itemGrid.append(card);
  }
  tree.append(itemGrid);
}

function renderCurrentTree(): void {
  if (layout === 'flat') {
    tree.replaceChildren();
    renderFlat();
    return;
  }
  status.classList.remove('flat-breadcrumb');
  renderTree(tree, filteredNodes(), {
    selectedId: selectedFolderId,
    inlineEditFolderId,
    onSelect: (node) => { if (node.nodeType === 'folder') { selectedFolderId = node.id; renderCurrentTree(); } },
    onInlineEdit: async (node, name) => {
      inlineEditFolderId = null;
      try {
        const updated = await updateNode(activeConfig, node, { name });
        currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
        renderCurrentTree();
      } catch (error) { showStatus(error instanceof Error ? error.message : '保存目录失败', true); }
    },
    onMove: async (draggedId, targetId, mode) => {
      await moveCurrentNode(draggedId, targetId, mode);
    },
    onContextMenu: showNodeContextMenu,
    onOpen: (node) => {
      if (node.nodeType === 'bookmark' && node.url) void chrome.tabs.create({ url: node.url });
      if (node.nodeType === 'text') void copyTextNode(node);
    }
  });
  showStatus(activeConfig && !offlineMode
    ? `已加载 ${currentNodes.filter((node) => node.nodeType !== 'folder').length} 条收藏`
    : `离线模式 · ${currentNodes.filter((node) => node.nodeType !== 'folder').length} 条收藏`);
}

async function refresh(): Promise<void> {
  try {
    currentNodes = await loadNodes(activeConfig);
    if (selectedFolderId && !currentNodes.some((node) => node.id === selectedFolderId && node.nodeType === 'folder')) selectedFolderId = null;
    if (flatFolderId && !currentNodes.some((node) => node.id === flatFolderId && node.nodeType === 'folder')) flatFolderId = null;
    renderCurrentTree();
  } catch (error) {
    tree.innerHTML = '<div class="empty">请先配置 Elasticsearch 连接。</div>';
    showStatus(error instanceof Error ? error.message : '加载失败', true);
  }
}

async function addBookmark(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error('当前页面不是 HTTP 或 HTTPS 网页，不能收藏。');
    const result = await showBookmarkDialog(currentNodes, { url: tab.url, title: tab.title ?? tab.url, iconUrl: tab.favIconUrl, folderId: currentFolderId() });
    if (!result) return;
    try {
      const created = await createBookmark(activeConfig, result.folderId, result.url, result.title, result.iconUrl);
      currentNodes = [...currentNodes, created];
    } catch (error) {
      if (!(error instanceof DuplicateBookmarkError)) throw error;
      const targetFolder = result.folderId ? currentNodes.find((node) => node.id === result.folderId)?.name ?? '选中文件夹' : '根目录';
      const shouldMove = await showConfirmDialog('地址已收藏', `${error.message}\n\n是否迁移到${targetFolder}，并更新标题和图标？`, '迁移收藏');
      if (!shouldMove) return;
      const updated = await updateNode(activeConfig, error.existing, { parentId: result.folderId, title: result.title, iconUrl: result.iconUrl });
      currentNodes = currentNodes.map((item) => item.id === updated.id ? updated : item);
    }
    renderCurrentTree();
  } catch (error) { showStatus(error instanceof Error ? error.message : '收藏失败', true); }
}

async function addFolder(): Promise<void> {
  try {
    const node = await createFolder(activeConfig, currentFolderId(), '未命名');
    currentNodes = [...currentNodes, node];
    if (layout === 'tree') {
      selectedFolderId = node.id;
      inlineEditFolderId = node.id;
    }
    renderCurrentTree();
  } catch (error) { showStatus(error instanceof Error ? error.message : '创建目录失败', true); }
}

document.querySelector<HTMLButtonElement>('#settings')!.addEventListener('click', () => void chrome.runtime.openOptionsPage());
document.querySelector<HTMLButtonElement>('#add-current')!.addEventListener('click', () => void addBookmark());
document.querySelector<HTMLButtonElement>('#add-folder')!.addEventListener('click', () => void addFolder());
document.querySelector<HTMLButtonElement>('#search-toggle')!.addEventListener('click', () => {
  searchBar.classList.toggle('hidden');
  if (!searchBar.classList.contains('hidden')) { searchInput.focus(); searchInput.select(); }
});
inlineFormMode.addEventListener('click', () => setInlineConfigMode('form'));
inlineJsonMode.addEventListener('click', () => setInlineConfigMode('json'));
for (const input of [inlineEsUrl, inlineApiKey, inlineIndexPrefix]) input.addEventListener('input', syncInlineFormToJson);
inlineConfigJson.addEventListener('input', syncInlineJsonToForm);
layoutToggle.addEventListener('click', () => {
  layout = layout === 'tree' ? 'flat' : 'tree';
  localStorage.setItem('popup-layout', layout);
  updateLayoutToggle();
  renderCurrentTree();
});
searchInput.addEventListener('input', () => renderCurrentTree());
treeScroll.addEventListener('contextmenu', showTreeContextMenu);

document.querySelector<HTMLButtonElement>('#inline-config-test')!.addEventListener('click', async () => {
  try { await testConnection(readInlineConfig()); showStatus('ES 连接成功'); }
  catch (error) { showStatus(error instanceof Error ? error.message : '连接失败', true); }
});
inlineConfigForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const config = readInlineConfig();
    showStatus('正在验证并切换 ES 连接…');
    await testConnection(config);
    await saveConfig(config);
    const savedConfig = await getConfig();
    if (!savedConfig) throw new Error('配置保存失败。');
    await bindProfile(savedConfig);
    activeConfig = savedConfig;
    offlineMode = false;
    await setOfflineMode(false);
    setConfiguredView(true);
    showStatus('配置已保存，连接测试成功');
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : '保存失败', true); }
});

inlineOffline.addEventListener('click', async () => {
  await setOfflineMode(true);
  activeConfig = null;
  offlineMode = true;
  setConfiguredView(true);
  await refresh();
});

async function refreshOnOpen(): Promise<void> {
  await refresh();
  if (activeConfig && !offlineMode) {
    showToast('正在后台同步…');
    void syncNow(activeConfig).then(() => refresh()).catch((error) => showToast(error instanceof Error ? `同步失败，已使用本地数据：${error.message}` : '同步失败，已使用本地数据', true));
  }
}

void Promise.all([getConfig(), getOfflineMode()]).then(([config, savedOfflineMode]) => {
  if (!isConfigComplete(config) && !savedOfflineMode) {
    setConfiguredView(false, config);
    showStatus('请先完成 ES 连接配置');
    return;
  }
  activeConfig = isConfigComplete(config) ? config : null;
  offlineMode = !activeConfig;
  setConfiguredView(true);
  return refreshOnOpen();
}).catch((error) => showStatus(error instanceof Error ? error.message : '加载失败', true));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[CONFIG_KEY]) return;
  selectedFolderId = null;
  flatFolderId = null;
  inlineEditFolderId = null;
  void getConfig().then((config) => { activeConfig = isConfigComplete(config) ? config : null; offlineMode = !activeConfig; return refresh(); });
});

window.addEventListener('online', () => {
  if (activeConfig) void chrome.runtime.sendMessage({ type: 'schedule-sync' }).catch(() => undefined);
});

updateLayoutToggle();
