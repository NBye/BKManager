import type { BookmarkNode, ConnectionConfig } from './types';
import { ensureEsPermission, validateConfig } from './config';
import { parseNode } from './nodes';
import { getIndexName } from './types';

const REQUEST_TIMEOUT_MS = 15000;

function endpoint(config: ConnectionConfig, suffix = ''): string {
  return `${config.esUrl.replace(/\/$/, '')}/${getIndexName(config)}${suffix}`;
}

function headers(config: ConnectionConfig): HeadersInit {
  return {
    Authorization: `ApiKey ${config.apiKey.trim()}`,
    'Content-Type': 'application/json'
  };
}

async function request<T>(config: ConnectionConfig, url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal, headers: { ...headers(config), ...(init.headers ?? {}) } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('ES 请求超时，请检查网络或服务器状态。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body
      ? JSON.stringify((body as { error: unknown }).error)
      : `${response.status} ${response.statusText}`;
    throw new Error(`ES 请求失败：${message}`);
  }
  return body as T;
}

export async function ensureIndex(config: ConnectionConfig): Promise<boolean> {
  validateConfig(config);
  try {
    await request(config, endpoint(config), { method: 'HEAD' });
    return false;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('404')) throw error;
  }
  try {
    await request(config, endpoint(config), {
      method: 'PUT',
      body: JSON.stringify({
        mappings: {
          properties: {
            id: { type: 'keyword' },
            nodeType: { type: 'keyword' },
            parentId: { type: 'keyword' },
            name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
            url: { type: 'keyword' },
            title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
            iconUrl: { type: 'keyword' },
            content: { type: 'text' },
            urlKey: { type: 'keyword' },
            sortOrder: { type: 'integer' },
            createdAt: { type: 'date' },
            updatedAt: { type: 'date' },
            deletedAt: { type: 'date' }
          }
        }
      })
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('resource_already_exists_exception')) return false;
    throw new Error('目标索引不存在，且当前授权 Key 没有创建索引权限。请先由管理员创建索引，或为授权 Key 增加 create_index 权限。');
  }
}

interface SearchResponse {
  hits?: {
    hits?: Array<{ _source?: unknown; sort?: unknown[] }>;
  };
}

interface BulkResponse {
  errors?: boolean;
  items?: Array<Record<string, { _id?: string; status?: number; error?: { reason?: string } }>>;
}

export interface BulkResult {
  succeededIds: string[];
  failed: Array<{ id: string; status?: number; reason: string }>;
}

function getBulkResult(result: BulkResponse, expectedIds: string[] = []): BulkResult {
  const succeededIds: string[] = [];
  const failed: BulkResult['failed'] = [];
  const items = result.items ?? [];
  for (let index = 0; index < expectedIds.length; index += 1) {
    const item = items[index];
    const entries = item ? Object.entries(item) : [];
    if (!entries.length) {
      failed.push({ id: expectedIds[index], reason: 'ES 未返回该节点的写入结果' });
      continue;
    }
    for (const [, detail] of entries) {
      const id = detail._id ?? expectedIds[index];
      if (detail.error) failed.push({ id, status: detail.status, reason: detail.error.reason ?? '部分文档写入失败' });
      else if (id) succeededIds.push(id);
    }
  }
  if (!expectedIds.length) {
    for (const item of items) {
      for (const [operation, detail] of Object.entries(item)) {
        const id = detail._id ?? '';
        if (detail.error) failed.push({ id, status: detail.status, reason: detail.error.reason ?? '部分文档写入失败' });
        else if (id && operation) succeededIds.push(id);
      }
    }
  }
  if (result.errors && !failed.length) failed.push({ id: '', reason: '部分文档写入失败' });
  return { succeededIds, failed };
}

export async function fetchAllNodes(config: ConnectionConfig): Promise<BookmarkNode[]> {
  const nodes: BookmarkNode[] = [];
  const invalid: string[] = [];
  let searchAfter: unknown[] | undefined;
  while (true) {
    const body: Record<string, unknown> = {
      size: 500,
      query: { match_all: {} },
      sort: [{ id: 'asc' }]
    };
    if (searchAfter) body.search_after = searchAfter;
    const result = await request<SearchResponse>(config, endpoint(config, '/_search'), {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const hits = result.hits?.hits ?? [];
    for (const hit of hits) {
      if (hit._source) {
        const parsed = parseNode(hit._source);
        if (parsed.node) nodes.push(parsed.node);
        else invalid.push(parsed.error ?? '节点格式无效');
      }
    }
    if (hits.length < 500) break;
    searchAfter = hits[hits.length - 1].sort;
    if (!searchAfter) break;
  }
  if (invalid.length) throw new Error(`ES 返回了 ${invalid.length} 个无效节点，已停止同步以保护数据：${invalid.slice(0, 2).join('；')}`);
  return nodes;
}

export async function bulkUpsert(config: ConnectionConfig, nodes: BookmarkNode[]): Promise<BulkResult> {
  if (!nodes.length) return { succeededIds: [], failed: [] };
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(JSON.stringify({ index: { _index: getIndexName(config), _id: node.id } }));
    lines.push(JSON.stringify(node));
  }
  const result = await request<BulkResponse>(config, `${config.esUrl.replace(/\/$/, '')}/_bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`
  });
  return getBulkResult(result, nodes.map((node) => node.id));
}

export async function bulkDelete(config: ConnectionConfig, ids: string[]): Promise<BulkResult> {
  if (!ids.length) return { succeededIds: [], failed: [] };
  const lines: string[] = [];
  for (const id of ids) lines.push(JSON.stringify({ delete: { _index: getIndexName(config), _id: id } }));
  const result = await request<BulkResponse>(config, `${config.esUrl.replace(/\/$/, '')}/_bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`
  });
  return getBulkResult(result, ids);
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  validateConfig(config);
  await ensureEsPermission(config);
  const created = await ensureIndex(config);
  if (created) await new Promise((resolve) => setTimeout(resolve, 1000));
  await request(config, endpoint(config, '/_search'), {
    method: 'POST',
    body: JSON.stringify({ size: 0, query: { match_all: {} } })
  });
}
