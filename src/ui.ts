import type { BookmarkNode } from './types';

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, error = false): void {
  if (toastTimer) clearTimeout(toastTimer);
  document.querySelector('.popup-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `popup-toast${error ? ' error' : ''}`;
  toast.textContent = message;
  document.body.append(toast);
  toastTimer = setTimeout(() => {
    toast.remove();
    toastTimer = null;
  }, 1800);
}

export interface BookmarkDialogData {
  url: string;
  title: string;
  iconUrl?: string;
  folderId: string | null;
}

interface BookmarkFormParts {
  form: HTMLFormElement;
  focusTitle: () => void;
}

function getOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function modalRoot(): HTMLElement {
  let root = document.querySelector<HTMLElement>('#modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.append(root);
  }
  return root;
}

function closeModal(): void {
  modalRoot().replaceChildren();
}

function createModal(title: string): { panel: HTMLElement; close: () => void } {
  const root = modalRoot();
  root.replaceChildren();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const panel = document.createElement('section');
  panel.className = 'modal-panel';
  const header = document.createElement('div');
  header.className = 'modal-header';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const close = document.createElement('button');
  close.className = 'modal-close';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';
  close.addEventListener('click', () => closeModal());
  header.append(heading, close);
  panel.append(header);
  backdrop.append(panel);
  root.append(backdrop);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(); });
  return { panel, close: closeModal };
}

function createBookmarkForm(nodes: BookmarkNode[], initial: BookmarkDialogData, onSubmit: (value: BookmarkDialogData) => void, onCancel: () => void, pageForm = false): BookmarkFormParts {
    const form = document.createElement('form');
    form.className = `form ${pageForm ? 'capture-form' : 'modal-form'}`;
    const iconField = document.createElement('div');
    iconField.className = 'bookmark-icon-field';
    const iconLabel = document.createElement('span');
    iconLabel.textContent = '网站图标';
    const iconPreview = document.createElement('span');
    iconPreview.className = 'bookmark-icon-preview';
    const iconImage = document.createElement('img');
    iconImage.alt = '网站图标预览';
    const iconFallback = document.createElement('span');
    iconFallback.className = 'bookmark-icon-fallback';
    iconFallback.textContent = '无图标';
    iconPreview.append(iconImage, iconFallback);
    iconField.append(iconLabel, iconPreview);
    const title = document.createElement('label');
    title.textContent = '标题';
    const titleInput = document.createElement('input');
    titleInput.value = initial.title;
    titleInput.required = true;
    title.append(titleInput);
    const url = document.createElement('label');
    url.textContent = '链接地址';
    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.value = initial.url;
    urlInput.required = true;
    url.append(urlInput);
    const folder = document.createElement('label');
    folder.textContent = '保存到文件夹';
    const folders = nodes.filter((node) => node.nodeType === 'folder' && !node.deletedAt).sort((left, right) => left.sortOrder - right.sortOrder);
    const foldersByParent = new Map<string | null, BookmarkNode[]>();
    for (const folderNode of folders) {
      const siblings = foldersByParent.get(folderNode.parentId) ?? [];
      siblings.push(folderNode);
      foldersByParent.set(folderNode.parentId, siblings);
    }
    const folderById = new Map(folders.map((folderNode) => [folderNode.id, folderNode]));
    let selectedFolderId = initial.folderId;
    const browser = document.createElement('div');
    browser.className = 'folder-browser';
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'folder-breadcrumb';
    const childFolders = document.createElement('div');
    childFolders.className = 'folder-child-list';
    const getSelectedPath = (): BookmarkNode[] => {
      const path: BookmarkNode[] = [];
      const visited = new Set<string>();
      let currentId = selectedFolderId;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const folderNode = folderById.get(currentId);
        if (!folderNode) break;
        path.unshift(folderNode);
        currentId = folderNode.parentId;
      }
      return path;
    };
    const renderFolderBrowser = (): void => {
      breadcrumb.replaceChildren();
      childFolders.replaceChildren();
      const selectedPathNodes = getSelectedPath();
      const root = document.createElement('button');
      root.type = 'button';
      root.className = `folder-breadcrumb-item${selectedFolderId === null ? ' active' : ''}`;
      root.textContent = '收藏';
      root.addEventListener('click', () => { selectedFolderId = null; renderFolderBrowser(); });
      breadcrumb.append(root);
      for (const folderNode of selectedPathNodes) {
        const separator = document.createElement('span');
        separator.className = 'folder-breadcrumb-separator';
        separator.textContent = '/';
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `folder-breadcrumb-item${selectedFolderId === folderNode.id ? ' active' : ''}`;
        item.textContent = folderNode.name ?? '未命名目录';
        item.addEventListener('click', () => { selectedFolderId = folderNode.id; renderFolderBrowser(); });
        breadcrumb.append(separator, item);
      }
      const children = foldersByParent.get(selectedFolderId) ?? [];
      if (!children.length) {
        const empty = document.createElement('span');
        empty.className = 'folder-child-empty';
        empty.textContent = '当前目录下没有子文件夹';
        childFolders.append(empty);
      } else {
        for (const folderNode of children) {
          const child = document.createElement('button');
          child.type = 'button';
          child.className = 'folder-child-button';
          child.innerHTML = '<span aria-hidden="true">📁</span>';
          child.append(document.createTextNode(folderNode.name ?? '未命名目录'));
          child.title = `进入 ${folderNode.name ?? '未命名目录'}`;
          child.addEventListener('click', () => { selectedFolderId = folderNode.id; renderFolderBrowser(); });
          childFolders.append(child);
        }
      }
    };
    renderFolderBrowser();
    browser.append(breadcrumb, childFolders);
    folder.append(browser);
    const initialOrigin = getOrigin(initial.url);
    let previewIconUrl = initial.iconUrl;
    const updateIconPreview = () => {
      const origin = getOrigin(urlInput.value);
      const nextIconUrl = origin === initialOrigin && initial.iconUrl ? initial.iconUrl : origin ? `${origin}/favicon.ico` : undefined;
      if (nextIconUrl === previewIconUrl && iconImage.src) return;
      previewIconUrl = nextIconUrl;
      iconFallback.classList.toggle('hidden', Boolean(nextIconUrl));
      iconImage.classList.toggle('hidden', !nextIconUrl);
      if (nextIconUrl) iconImage.src = nextIconUrl;
      else iconImage.removeAttribute('src');
    };
    iconImage.addEventListener('load', () => {
      iconImage.classList.remove('hidden');
      iconFallback.classList.add('hidden');
    });
    iconImage.addEventListener('error', () => {
      iconImage.classList.add('hidden');
      iconFallback.classList.remove('hidden');
    });
    urlInput.addEventListener('input', updateIconPreview);
    updateIconPreview();
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = '取消';
    cancel.addEventListener('click', onCancel);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = '保存收藏';
    actions.append(cancel, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onSubmit({ url: urlInput.value.trim(), title: titleInput.value.trim(), iconUrl: previewIconUrl, folderId: selectedFolderId });
    });
    form.append(iconField, title, url, folder, actions);
    return { form, focusTitle: () => { titleInput.focus(); titleInput.select(); } };
}

export function showBookmarkDialog(nodes: BookmarkNode[], initial: BookmarkDialogData): Promise<BookmarkDialogData | null> {
  return new Promise((resolve) => {
    const { panel } = createModal('收藏地址');
    const parts = createBookmarkForm(nodes, initial, (value) => { closeModal(); resolve(value); }, () => { closeModal(); resolve(null); });
    panel.append(parts.form);
    setTimeout(parts.focusTitle, 0);
  });
}

export function showBookmarkFormPage(container: HTMLElement, nodes: BookmarkNode[], initial: BookmarkDialogData): Promise<BookmarkDialogData | null> {
  return new Promise((resolve) => {
    const heading = document.createElement('h1');
    heading.className = 'capture-title';
    heading.textContent = '收藏地址';
    const parts = createBookmarkForm(nodes, initial, (value) => { container.replaceChildren(); resolve(value); }, () => { container.replaceChildren(); resolve(null); }, true);
    container.replaceChildren(heading, parts.form);
    setTimeout(parts.focusTitle, 0);
  });
}

export function showTextDialog(titleText: string, labelText: string, initialValue: string): Promise<string | null> {
  return new Promise((resolve) => {
    const { panel } = createModal(titleText);
    const form = document.createElement('form');
    form.className = 'form modal-form';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.value = initialValue;
    input.required = true;
    label.append(input);
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => { closeModal(); resolve(null); });
    const submit = document.createElement('button');
    submit.type = 'submit'; submit.className = 'primary'; submit.textContent = '保存';
    actions.append(cancel, submit);
    form.append(label, actions);
    form.addEventListener('submit', (event) => { event.preventDefault(); closeModal(); resolve(input.value.trim()); });
    panel.append(form);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

export function showTextContentDialog(titleText: string, initial: { title: string; content: string }): Promise<{ title: string; content: string } | null> {
  return new Promise((resolve) => {
    const { panel } = createModal(titleText);
    const form = document.createElement('form');
    form.className = 'form modal-form';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = '标题';
    const titleInput = document.createElement('input');
    titleInput.value = initial.title;
    titleInput.required = true;
    titleLabel.append(titleInput);
    const contentLabel = document.createElement('label');
    contentLabel.textContent = '文案内容';
    const contentInput = document.createElement('textarea');
    contentInput.value = initial.content;
    contentInput.required = true;
    contentInput.rows = 8;
    contentLabel.append(contentInput);
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => { closeModal(); resolve(null); });
    const submit = document.createElement('button');
    submit.type = 'submit'; submit.className = 'primary'; submit.textContent = '保存';
    actions.append(cancel, submit);
    form.append(titleLabel, contentLabel, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      closeModal();
      resolve({ title: titleInput.value.trim(), content: contentInput.value });
    });
    panel.append(form);
    setTimeout(() => { titleInput.focus(); titleInput.select(); }, 0);
  });
}

export function showConfirmDialog(titleText: string, message: string, confirmText = '确认'): Promise<boolean> {
  return new Promise((resolve) => {
    const { panel } = createModal(titleText);
    const content = document.createElement('p');
    content.className = 'modal-message';
    content.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const cancel = document.createElement('button');
    cancel.className = 'secondary'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => { closeModal(); resolve(false); });
    const confirm = document.createElement('button');
    confirm.className = 'primary'; confirm.textContent = confirmText;
    confirm.addEventListener('click', () => { closeModal(); resolve(true); });
    actions.append(cancel, confirm);
    panel.append(content, actions);
  });
}
