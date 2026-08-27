import type { BookmarkNode } from './types';

export function getNodeTitle(node: BookmarkNode): string {
  return node.nodeType === 'folder' ? (node.name ?? '未命名目录') : (node.title ?? node.url ?? '未命名收藏');
}

export function getNodeTooltip(node: BookmarkNode): string {
  return node.nodeType === 'text' ? (node.content ?? getNodeTitle(node)) : node.nodeType === 'bookmark' ? (node.url ?? getNodeTitle(node)) : getNodeTitle(node);
}

export function countChildNodes(nodes: BookmarkNode[], parentId: string | null): number {
  return nodes.filter((node) => node.parentId === parentId && !node.deletedAt).length;
}

export async function copyNode(node: BookmarkNode): Promise<void> {
  if (node.nodeType !== 'text') throw new Error('只有文案节点可以复制。');
  await navigator.clipboard.writeText(node.content ?? '');
}
