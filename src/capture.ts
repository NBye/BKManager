import './styles.css';
import { createBookmark, DuplicateBookmarkError, loadNodes, updateNode } from './app';
import { getConfig, getOfflineMode, isConfigComplete } from './config';
import { showBookmarkFormPage, showConfirmDialog } from './ui';

const params = new URLSearchParams(location.search);
const status = document.querySelector<HTMLElement>('#status')!;

async function init(): Promise<void> {
  const [storedConfig, offlineMode] = await Promise.all([getConfig(), getOfflineMode()]);
  const config = isConfigComplete(storedConfig) ? storedConfig : null;
  if (!config && !offlineMode) throw new Error('请先配置 Elasticsearch，或在插件首页选择“离线使用”。');
  const nodes = await loadNodes(config);
  const formContainer = document.querySelector<HTMLElement>('#bookmark-form')!;
  const result = await showBookmarkFormPage(formContainer, nodes, {
    url: params.get('url') ?? '',
    title: params.get('title') ?? params.get('url') ?? '',
    iconUrl: params.get('iconUrl') ?? undefined,
    folderId: null
  });
  if (!result) { window.close(); return; }
  try {
    await createBookmark(config, result.folderId, result.url, result.title, result.iconUrl);
  } catch (error) {
    if (!(error instanceof DuplicateBookmarkError)) throw error;
    const targetFolder = result.folderId ? nodes.find((node) => node.id === result.folderId)?.name ?? '选中文件夹' : '根目录';
    const shouldMove = await showConfirmDialog('地址已收藏', `${error.message}\n\n是否迁移到${targetFolder}，并更新标题和图标？`, '迁移收藏');
    if (!shouldMove) { window.close(); return; }
    await updateNode(config, error.existing, { parentId: result.folderId, title: result.title, iconUrl: result.iconUrl });
  }
  window.close();
}

void init().catch((error) => {
  status.textContent = error instanceof Error ? error.message : '初始化失败';
  status.classList.add('error');
});
