import type { BookmarkNode } from './types';
import { isBase64IconUrl } from './nodes';

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

export interface FolderDialogData {
  name: string;
  folderId: string | null;
}

export interface TextContentDialogData {
  title: string;
  content: string;
  folderId: string | null;
}

interface BookmarkFormParts {
  form: HTMLFormElement;
  focusTitle: () => void;
}

interface FormParts {
  form: HTMLFormElement;
  focus: () => void;
}

export type CreateDialogResult =
  | { nodeType: 'bookmark'; data: BookmarkDialogData }
  | { nodeType: 'folder'; name: string; folderId: string | null }
  | { nodeType: 'text'; title: string; content: string; folderId: string | null };

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

function createModal(title: string, backdropClass = ''): { panel: HTMLElement; close: () => void } {
  const root = modalRoot();
  root.replaceChildren();
  const backdrop = document.createElement('div');
  backdrop.className = `modal-backdrop${backdropClass ? ` ${backdropClass}` : ''}`;
  const panel = document.createElement('section');
  panel.className = 'modal-panel';
  const header = document.createElement('div');
  header.className = 'modal-header';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const close = document.createElement('button');
  close.className = 'modal-close';
  close.setAttribute('aria-label', '关闭');
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  close.addEventListener('click', () => closeModal());
  header.append(heading, close);
  panel.append(header);
  backdrop.append(panel);
  root.append(backdrop);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(); });
  return { panel, close: closeModal };
}

function createFormActions(onCancel: () => void, submitText: string): HTMLDivElement {
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
  submit.textContent = submitText;
  actions.append(cancel, submit);
  return actions;
}

function getExcludedFolderIds(nodes: BookmarkNode[], rootId?: string): Set<string> {
  if (!rootId) return new Set();
  const excluded = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.nodeType === 'folder' && node.parentId && excluded.has(node.parentId) && !excluded.has(node.id)) {
        excluded.add(node.id);
        changed = true;
      }
    }
  }
  return excluded;
}

function createFolderField(nodes: BookmarkNode[], initialFolderId: string | null, excludedRootId?: string): { field: HTMLLabelElement; getFolderId: () => string | null } {
  const field = document.createElement('label');
  field.textContent = '保存到文件夹';
  const excludedIds = getExcludedFolderIds(nodes, excludedRootId);
  const folders = nodes
    .filter((node) => node.nodeType === 'folder' && !node.deletedAt && !excludedIds.has(node.id))
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const foldersByParent = new Map<string | null, BookmarkNode[]>();
  for (const folderNode of folders) {
    const parentId = excludedIds.has(folderNode.parentId ?? '') ? null : folderNode.parentId;
    const siblings = foldersByParent.get(parentId) ?? [];
    siblings.push(folderNode);
    foldersByParent.set(parentId, siblings);
  }
  const folderById = new Map(folders.map((folderNode) => [folderNode.id, folderNode]));
  let selectedFolderId = initialFolderId && folderById.has(initialFolderId) ? initialFolderId : null;
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
  const render = (): void => {
    breadcrumb.replaceChildren();
    childFolders.replaceChildren();
    const root = document.createElement('button');
    root.type = 'button';
    root.className = `folder-breadcrumb-item${selectedFolderId === null ? ' active' : ''}`;
    root.textContent = '收藏';
    root.addEventListener('click', () => { selectedFolderId = null; render(); });
    breadcrumb.append(root);
    for (const folderNode of getSelectedPath()) {
      const separator = document.createElement('span');
      separator.className = 'folder-breadcrumb-separator';
      separator.textContent = '/';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `folder-breadcrumb-item${selectedFolderId === folderNode.id ? ' active' : ''}`;
      item.textContent = folderNode.name ?? '未命名目录';
      item.addEventListener('click', () => { selectedFolderId = folderNode.id; render(); });
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
        child.addEventListener('click', () => { selectedFolderId = folderNode.id; render(); });
        childFolders.append(child);
      }
    }
  };
  render();
  browser.append(breadcrumb, childFolders);
  field.append(browser);
  return { field, getFolderId: () => selectedFolderId };
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
    const removeIcon = document.createElement('button');
    removeIcon.type = 'button';
    removeIcon.className = 'bookmark-icon-remove';
    removeIcon.setAttribute('aria-label', '删除网站图标');
    removeIcon.title = '删除网站图标';
    removeIcon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    iconPreview.append(iconImage, iconFallback, removeIcon);
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
    const folderSelection = createFolderField(nodes, initial.folderId);
    const initialOrigin = getOrigin(initial.url);
    const initialHasBase64Icon = isBase64IconUrl(initial.iconUrl);
    if (initialHasBase64Icon) showToast('图标base64，已被删除。');
    let previewIconUrl = initialHasBase64Icon ? undefined : initial.iconUrl;
    let iconRemoved = initialHasBase64Icon;
    const updateIconPreview = () => {
      const origin = getOrigin(urlInput.value);
      const nextIconUrl = iconRemoved
        ? undefined
        : origin === initialOrigin && initial.iconUrl
          ? initial.iconUrl
          : origin
            ? `${origin}/favicon.ico`
            : undefined;
      if (nextIconUrl === previewIconUrl && iconImage.src) return;
      previewIconUrl = nextIconUrl;
      iconFallback.classList.toggle('hidden', Boolean(nextIconUrl));
      iconImage.classList.toggle('hidden', !nextIconUrl);
      removeIcon.classList.toggle('hidden', !nextIconUrl);
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
    removeIcon.addEventListener('click', () => {
      iconRemoved = true;
      updateIconPreview();
    });
    urlInput.addEventListener('input', updateIconPreview);
    updateIconPreview();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onSubmit({ url: urlInput.value.trim(), title: titleInput.value.trim(), iconUrl: previewIconUrl, folderId: folderSelection.getFolderId() });
    });
    form.append(iconField, title, url, folderSelection.field, createFormActions(onCancel, '保存收藏'));
    return { form, focusTitle: () => { titleInput.focus(); titleInput.select(); } };
}

function createFolderForm(
  nodes: BookmarkNode[],
  initial: FolderDialogData,
  onSubmit: (value: FolderDialogData) => void,
  onCancel: () => void,
  submitText = '保存',
  excludedFolderId?: string
): FormParts {
  const form = document.createElement('form');
  form.className = 'form modal-form';
  const label = document.createElement('label');
  label.textContent = '文件夹名称';
  const input = document.createElement('input');
  input.value = initial.name;
  input.required = true;
  label.append(input);
  const folderSelection = createFolderField(nodes, initial.folderId, excludedFolderId);
  form.append(label, folderSelection.field, createFormActions(onCancel, submitText));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit({ name: input.value.trim(), folderId: folderSelection.getFolderId() });
  });
  return { form, focus: () => { input.focus(); input.select(); } };
}

function createTextContentForm(
  nodes: BookmarkNode[],
  initial: TextContentDialogData,
  onSubmit: (value: TextContentDialogData) => void,
  onCancel: () => void,
  submitText = '保存',
  titleRequired = true
): FormParts {
  const form = document.createElement('form');
  form.className = 'form modal-form';
  const titleLabel = document.createElement('label');
  titleLabel.textContent = '标题';
  const titleInput = document.createElement('input');
  titleInput.value = initial.title;
  titleInput.required = titleRequired;
  titleLabel.append(titleInput);
  const contentLabel = document.createElement('label');
  contentLabel.textContent = '文案内容';
  const contentInput = document.createElement('textarea');
  contentInput.value = initial.content;
  contentInput.required = true;
  contentInput.rows = 8;
  contentLabel.append(contentInput);
  const folderSelection = createFolderField(nodes, initial.folderId);
  form.append(titleLabel, contentLabel, folderSelection.field, createFormActions(onCancel, submitText));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit({ title: titleInput.value.trim(), content: contentInput.value, folderId: folderSelection.getFolderId() });
  });
  return { form, focus: () => { titleInput.focus(); titleInput.select(); } };
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

export function showCreateDialog(nodes: BookmarkNode[], folderId: string | null): Promise<CreateDialogResult | null> {
  return new Promise((resolve) => {
    const { panel } = createModal('新建', 'create-modal-backdrop');
    const tabs = document.createElement('div');
    tabs.className = 'settings-mode-tabs create-type-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '新建类型');
    const content = document.createElement('div');
    content.className = 'create-dialog-content';
    const tabButtons = new Map<CreateDialogResult['nodeType'], HTMLButtonElement>();
    let settled = false;
    const finish = (result: CreateDialogResult | null): void => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(result);
    };
    const cancel = (): void => finish(null);
    const render = (nodeType: CreateDialogResult['nodeType']): void => {
      for (const [type, button] of tabButtons) {
        button.classList.toggle('active', type === nodeType);
        button.setAttribute('aria-selected', String(type === nodeType));
      }
      content.replaceChildren();
      if (nodeType === 'bookmark') {
        const parts = createBookmarkForm(nodes, { url: '', title: '', folderId }, (data) => finish({ nodeType, data }), cancel);
        content.append(parts.form);
        setTimeout(parts.focusTitle, 0);
        return;
      }
      if (nodeType === 'folder') {
        const parts = createFolderForm(nodes, { name: '', folderId }, (value) => finish({ nodeType, name: value.name || '未命名', folderId: value.folderId }), cancel, '创建文件夹');
        const input = parts.form.querySelector<HTMLInputElement>('input');
        if (input) input.placeholder = '未命名';
        content.append(parts.form);
        setTimeout(parts.focus, 0);
        return;
      }
      const parts = createTextContentForm(nodes, { title: '', content: '', folderId }, (value) => finish({ nodeType, ...value }), cancel, '创建文本', false);
      content.append(parts.form);
      setTimeout(parts.focus, 0);
    };
    for (const [nodeType, label] of [['bookmark', '链接'], ['folder', '文件夹'], ['text', '文本']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = label;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => render(nodeType));
      tabButtons.set(nodeType, button);
      tabs.append(button);
    }
    panel.append(tabs, content);
    render('text');
  });
}

export function showFolderDialog(titleText: string, nodes: BookmarkNode[], initial: FolderDialogData, folderId: string): Promise<FolderDialogData | null> {
  return new Promise((resolve) => {
    const { panel } = createModal(titleText);
    const parts = createFolderForm(nodes, initial, (value) => { closeModal(); resolve(value); }, () => { closeModal(); resolve(null); }, '保存', folderId);
    panel.append(parts.form);
    setTimeout(parts.focus, 0);
  });
}

export function showTextContentDialog(titleText: string, nodes: BookmarkNode[], initial: TextContentDialogData): Promise<TextContentDialogData | null> {
  return new Promise((resolve) => {
    const { panel } = createModal(titleText);
    const parts = createTextContentForm(nodes, initial, (value) => { closeModal(); resolve(value); }, () => { closeModal(); resolve(null); });
    panel.append(parts.form);
    setTimeout(parts.focus, 0);
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
