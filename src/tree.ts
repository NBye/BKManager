import type { BookmarkNode } from './types';
import { getDisplayName } from './app';

export interface TreeOptions {
  showActions?: boolean;
  showDate?: boolean;
  onAddFolder?: (parent: BookmarkNode) => void;
  selectedId?: string | null;
  onSelect?: (node: BookmarkNode) => void;
  inlineEditFolderId?: string | null;
  onInlineEdit?: (node: BookmarkNode, name: string) => void;
  onContextMenu?: (node: BookmarkNode, event: MouseEvent) => void;
  onMove?: (draggedId: string, targetId: string, mode: 'before' | 'after' | 'inside') => void;
  onEdit?: (node: BookmarkNode) => void;
  onDelete?: (node: BookmarkNode) => void;
  onOpen?: (node: BookmarkNode) => void;
}

const collapsedByContainer = new WeakMap<HTMLElement, Set<string>>();

function stateKey(container: HTMLElement): string {
  return `tree-collapsed:${location.pathname}:${container.id || 'tree'}`;
}

function loadCollapsed(container: HTMLElement, nodes: BookmarkNode[]): Set<string> {
  const stored = localStorage.getItem(stateKey(container));
  if (stored !== null) {
    try {
      const ids = JSON.parse(stored) as unknown;
      if (Array.isArray(ids)) return new Set(ids.filter((id): id is string => typeof id === 'string'));
    } catch {
      localStorage.removeItem(stateKey(container));
    }
  }
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const collapsed = new Set<string>();
  for (const node of nodes) {
    if (node.nodeType !== 'folder') continue;
    let depth = 0;
    let parentId = node.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = parentById.get(parentId) ?? null;
    }
    if (depth > 0) collapsed.add(node.id);
  }
  return collapsed;
}

function saveCollapsed(container: HTMLElement, collapsed: Set<string>): void {
  localStorage.setItem(stateKey(container), JSON.stringify([...collapsed]));
}

export function renderTree(container: HTMLElement, nodes: BookmarkNode[], options: TreeOptions = {}): void {
  container.replaceChildren();
  const children = new Map<string | null, BookmarkNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
  const collapsed = collapsedByContainer.get(container) ?? loadCollapsed(container, nodes);
  collapsedByContainer.set(container, collapsed);

  const renderLevel = (parentId: string | null, parent: HTMLElement, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      if (options.selectedId === node.id) row.classList.add('selected');
      row.draggable = true;
      row.dataset.nodeId = node.id;
      row.style.paddingLeft = `${depth * 18 + 8}px`;
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', node.id);
      });
      row.addEventListener('dragover', (event) => event.preventDefault());
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        const draggedId = event.dataTransfer?.getData('text/plain');
        if (!draggedId || !options.onMove) return;
        const bounds = row.getBoundingClientRect();
        const offset = event.clientY - bounds.top;
        const mode = node.nodeType === 'folder' && offset > bounds.height * 0.65
          ? 'inside'
          : offset < bounds.height / 2 ? 'before' : 'after';
        options.onMove(draggedId, node.id, mode);
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        options.onContextMenu?.(node, event);
      });

      const toggle = document.createElement('button');
      toggle.className = 'tree-toggle';
      toggle.textContent = node.nodeType === 'folder' ? (collapsed.has(node.id) ? '▸' : '▾') : '';
      toggle.addEventListener('click', () => {
        if (node.nodeType !== 'folder') return;
        if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id);
        saveCollapsed(container, collapsed);
        renderTree(container, nodes, options);
      });
      row.append(toggle);

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      if (node.nodeType === 'bookmark' && node.iconUrl) {
        const image = document.createElement('img');
        image.src = node.iconUrl;
        image.alt = '';
        image.onerror = () => { image.replaceWith(document.createTextNode('🔗')); };
        icon.append(image);
      } else {
        icon.textContent = node.nodeType === 'folder' ? '📁' : '🔗';
      }
      row.append(icon);

      if (node.nodeType === 'folder' && options.inlineEditFolderId === node.id) {
        const input = document.createElement('input');
        input.className = 'tree-inline-input';
        input.value = node.name ?? '未命名';
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); options.onInlineEdit?.(node, input.value.trim() || '未命名'); }
          if (event.key === 'Escape') options.onInlineEdit?.(node, node.name ?? '未命名');
        });
        input.addEventListener('blur', () => options.onInlineEdit?.(node, input.value.trim() || '未命名'));
        row.append(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        const label = document.createElement('button');
        label.className = 'tree-label';
        label.textContent = getDisplayName(node);
        label.title = node.url ?? getDisplayName(node);
        label.addEventListener('click', () => {
          options.onSelect?.(node);
          if (node.nodeType === 'bookmark') options.onOpen?.(node);
        });
        row.append(label);
      }

      if (options.showDate && node.nodeType === 'bookmark') {
        const date = document.createElement('time');
        date.className = 'tree-date';
        date.textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(node.createdAt ?? node.updatedAt);
        row.append(date);
      }

      if (options.showActions || (node.nodeType === 'folder' && options.onAddFolder)) {
        const actions = document.createElement('span');
        actions.className = 'tree-actions';
        if (node.nodeType === 'folder' && options.onAddFolder) {
          const addFolder = document.createElement('button');
          addFolder.textContent = '子目录';
          addFolder.addEventListener('click', () => options.onAddFolder?.(node));
          actions.append(addFolder);
        }
        if (options.showActions) {
          const edit = document.createElement('button');
          edit.textContent = '编辑';
          edit.addEventListener('click', () => options.onEdit?.(node));
          const remove = document.createElement('button');
          remove.textContent = '删除';
          remove.addEventListener('click', () => options.onDelete?.(node));
          actions.append(edit, remove);
        }
        row.append(actions);
      }
      parent.append(row);
      if (node.nodeType === 'folder' && !collapsed.has(node.id)) renderLevel(node.id, parent, depth + 1);
    }
  };

  renderLevel(null, container, 0);
}
