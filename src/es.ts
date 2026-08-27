import type { BookmarkNode, ConnectionConfig } from './types';
import { getIndexName } from './types';

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
  const response = await fetch(url, { ...init, headers: { ...headers(config), ...(init.headers ?? {}) } });
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
    hits?: Array<{ _source?: BookmarkNode; sort?: unknown[] }>;
  };
}

interface BulkResponse {
  errors?: boolean;
  items?: Array<Record<string, { error?: { reason?: string } }>>;
}

function assertBulkSucceeded(result: BulkResponse): void {
  if (!result.errors) return;
  const failure = result.items?.flatMap((item) => Object.values(item)).find((item) => item.error)?.error;
  throw new Error(`ES 批量操作失败：${failure?.reason ?? '部分文档写入失败'}`);
}

export async function fetchAllNodes(config: ConnectionConfig): Promise<BookmarkNode[]> {
  const nodes: BookmarkNode[] = [];
  let searchAfter: unknown[] | undefined;
  while (true) {
    const body: Record<string, unknown> = {
      size: 500,
      query: { match_all: {} },
      sort: [{ updatedAt: 'asc' }, { id: 'asc' }]
    };
    if (searchAfter) body.search_after = searchAfter;
    const result = await request<SearchResponse>(config, endpoint(config, '/_search'), {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const hits = result.hits?.hits ?? [];
    for (const hit of hits) {
      if (hit._source) nodes.push(hit._source);
    }
    if (hits.length < 500) break;
    searchAfter = hits[hits.length - 1].sort;
    if (!searchAfter) break;
  }
  return nodes;
}

export async function bulkUpsert(config: ConnectionConfig, nodes: BookmarkNode[]): Promise<void> {
  if (!nodes.length) return;
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
  assertBulkSucceeded(result);
}

export async function bulkDelete(config: ConnectionConfig, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const lines: string[] = [];
  for (const id of ids) lines.push(JSON.stringify({ delete: { _index: getIndexName(config), _id: id } }));
  const result = await request<BulkResponse>(config, `${config.esUrl.replace(/\/$/, '')}/_bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`
  });
  assertBulkSucceeded(result);
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  const created = await ensureIndex(config);
  if (created) await new Promise((resolve) => setTimeout(resolve, 1000));
  await request(config, endpoint(config, '/_search'), {
    method: 'POST',
    body: JSON.stringify({ size: 0, query: { match_all: {} } })
  });
}
