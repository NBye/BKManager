import type { BookmarkNode } from './types';

export interface BookmarkDialogData {
  url: string;
  title: string;
  iconUrl?: string;
  folderId: string | null;
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

export function showBookmarkDialog(nodes: BookmarkNode[], initial: BookmarkDialogData): Promise<BookmarkDialogData | null> {
  return new Promise((resolve) => {
    const { panel } = createModal('收藏地址');
    const form = document.createElement('form');
    form.className = 'form modal-form';
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
    cancel.addEventListener('click', () => { closeModal(); resolve(null); });
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = '保存收藏';
    actions.append(cancel, submit);
    form.append(iconField, title, url, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      closeModal();
      resolve({ url: urlInput.value.trim(), title: titleInput.value.trim(), iconUrl: previewIconUrl, folderId: initial.folderId });
    });
    panel.append(form);
    setTimeout(() => titleInput.focus(), 0);
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
