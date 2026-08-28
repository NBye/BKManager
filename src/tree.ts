import type { BookmarkNode } from './types';
import { getNodeTitle, getNodeTooltip } from './node-service';

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
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const nestedFolderIds = new Set<string>();
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
    if (depth > 0) nestedFolderIds.add(node.id);
  }
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === 'string'));
      if (parsed && typeof parsed === 'object') {
        const state = parsed as { collapsed?: unknown; expanded?: unknown };
        const collapsed = new Set(typeof state.collapsed === 'object' && Array.isArray(state.collapsed)
          ? state.collapsed.filter((id): id is string => typeof id === 'string')
          : []);
        const expanded = new Set(typeof state.expanded === 'object' && Array.isArray(state.expanded)
          ? state.expanded.filter((id): id is string => typeof id === 'string')
          : []);
        for (const id of nestedFolderIds) {
          if (!collapsed.has(id) && !expanded.has(id)) collapsed.add(id);
        }
        return collapsed;
      }
    } catch {
      localStorage.removeItem(stateKey(container));
    }
  }
  return nestedFolderIds;
}

function saveCollapsed(container: HTMLElement, collapsed: Set<string>, nodes: BookmarkNode[]): void {
  const expanded = new Set<string>();
  const stored = localStorage.getItem(stateKey(container));
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { expanded?: unknown };
      if (Array.isArray(parsed.expanded)) {
        for (const id of parsed.expanded) if (typeof id === 'string') expanded.add(id);
      }
    } catch {
      expanded.clear();
    }
  }
  for (const node of nodes) {
    if (node.nodeType !== 'folder') continue;
    if (collapsed.has(node.id)) expanded.delete(node.id);
    else expanded.add(node.id);
  }
  localStorage.setItem(stateKey(container), JSON.stringify({ collapsed: [...collapsed], expanded: [...expanded] }));
}

function createActionIcon(label: string, path: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tree-action-icon';
  button.setAttribute('aria-label', label);
  button.title = label;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  iconPath.setAttribute('d', path);
  icon.append(iconPath);
  button.append(icon);
  return button;
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
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const structurallyReachable = new Set<string>();
  const markReachable = (nodeId: string): void => {
    if (structurallyReachable.has(nodeId)) return;
    structurallyReachable.add(nodeId);
    for (const child of children.get(nodeId) ?? []) markReachable(child.id);
  };
  for (const node of nodes) {
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    if (node.parentId === null || !parent || parent.nodeType !== 'folder') markReachable(node.id);
  }
  const disconnected = nodes.filter((node) => !structurallyReachable.has(node.id));
  if (disconnected.length) {
    const roots = children.get(null) ?? [];
    roots.push(...disconnected);
    roots.sort((a, b) => a.sortOrder - b.sortOrder);
    children.set(null, roots);
  }
  const collapsed = collapsedByContainer.get(container) ?? loadCollapsed(container, nodes);
  collapsedByContainer.set(container, collapsed);
  const renderedIds = new Set<string>();

  const renderLevel = (parentId: string | null, parent: HTMLElement, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      if (renderedIds.has(node.id)) continue;
      renderedIds.add(node.id);
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
        saveCollapsed(container, collapsed, nodes);
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
        icon.textContent = node.nodeType === 'folder' ? '📁' : node.nodeType === 'text' ? '📝' : '🔗';
      }
      row.append(icon);

      if (node.nodeType === 'folder' && options.inlineEditFolderId === node.id) {
        const input = document.createElement('input');
        input.className = 'tree-inline-input';
        input.value = node.name ?? '未命名';
        let finished = false;
        const finish = (name: string) => {
          if (finished) return;
          finished = true;
          options.onInlineEdit?.(node, name);
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); finish(input.value.trim() || '未命名'); }
          if (event.key === 'Escape') { event.preventDefault(); finish(node.name ?? '未命名'); }
        });
        input.addEventListener('blur', () => finish(input.value.trim() || '未命名'));
        row.append(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        const label = document.createElement('button');
        label.className = 'tree-label';
        label.textContent = getNodeTitle(node);
        label.title = getNodeTooltip(node);
        label.addEventListener('click', () => {
          options.onSelect?.(node);
          if (node.nodeType !== 'folder') options.onOpen?.(node);
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
          const addFolder = createActionIcon('创建子目录', 'M12 5v14M5 12h14');
          addFolder.addEventListener('click', () => options.onAddFolder?.(node));
          actions.append(addFolder);
        }
        if (options.showActions) {
          const edit = createActionIcon('编辑', 'm4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm10.5-12.5 3 3');
          edit.addEventListener('click', () => options.onEdit?.(node));
          actions.append(edit);
        }
        if (options.showActions) {
          const remove = createActionIcon('删除', 'M5 7h14m-9 4v6m4-6v6M9 7V5h6v2m-8 0 1 13h8l1-13');
          remove.addEventListener('click', () => options.onDelete?.(node));
          actions.append(remove);
        }
        row.append(actions);
      }
      parent.append(row);
      if (node.nodeType === 'folder' && !collapsed.has(node.id)) renderLevel(node.id, parent, depth + 1);
    }
  };

  renderLevel(null, container, 0);
}
