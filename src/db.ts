import type { BookmarkNode, SyncMeta, SyncOperation } from './types';

const DB_NAME = 'bookmark-manager-local';
const DB_VERSION = 2;

interface StoredNode extends BookmarkNode {
  profileKey: string;
}

interface StoredOperation extends SyncOperation {
  profileKey: string;
}

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    const nodes = database.objectStoreNames.contains('nodes')
      ? request.transaction!.objectStore('nodes')
      : database.createObjectStore('nodes', { keyPath: ['profileKey', 'id'] });
    if (!nodes.indexNames.contains('profileKey')) nodes.createIndex('profileKey', 'profileKey');
    if (!nodes.indexNames.contains('profileAndUpdatedAt')) nodes.createIndex('profileAndUpdatedAt', ['profileKey', 'updatedAt']);
    const operations = database.objectStoreNames.contains('operations')
      ? request.transaction!.objectStore('operations')
      : database.createObjectStore('operations', { keyPath: 'id' });
    if (!operations.indexNames.contains('profileKey')) operations.createIndex('profileKey', 'profileKey');
    if (!operations.indexNames.contains('profileAndQueuedAt')) operations.createIndex('profileAndQueuedAt', ['profileKey', 'queuedAt']);
    if (!operations.indexNames.contains('profileAndRetryAt')) operations.createIndex('profileAndRetryAt', ['profileKey', 'nextRetryAt']);
    if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'profileKey' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getNodes(profileKey: string): Promise<BookmarkNode[]> {
  const database = await openDb();
  const transaction = database.transaction('nodes', 'readonly');
  const index = transaction.objectStore('nodes').index('profileKey');
  const records = await requestResult<StoredNode[]>(index.getAll(profileKey));
  database.close();
  return records.map(({ profileKey: _profileKey, ...node }) => node);
}

export async function putNodes(profileKey: string, nodes: BookmarkNode[]): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction('nodes', 'readwrite');
  const store = transaction.objectStore('nodes');
  for (const node of nodes) {
    store.put({ ...node, profileKey } satisfies StoredNode);
  }
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function replaceNodes(profileKey: string, nodes: BookmarkNode[]): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction('nodes', 'readwrite');
  const store = transaction.objectStore('nodes');
  const existingKeys = await requestResult<IDBValidKey[]>(store.index('profileKey').getAllKeys(profileKey));
  for (const key of existingKeys) store.delete(key);
  for (const node of nodes) store.put({ ...node, profileKey } satisfies StoredNode);
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function replaceNodesAndRemoveOperations(profileKey: string, nodes: BookmarkNode[], operationIds?: string[]): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction(['nodes', 'operations'], 'readwrite');
  const nodeStore = transaction.objectStore('nodes');
  const operationStore = transaction.objectStore('operations');
  const nodeKeys = await requestResult<IDBValidKey[]>(nodeStore.index('profileKey').getAllKeys(profileKey));
  const operationKeys = operationIds === undefined
    ? await requestResult<IDBValidKey[]>(operationStore.index('profileKey').getAllKeys(profileKey))
    : operationIds;
  for (const key of nodeKeys) nodeStore.delete(key);
  for (const key of operationKeys) operationStore.delete(key);
  for (const node of nodes) nodeStore.put({ ...node, profileKey } satisfies StoredNode);
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function putNode(profileKey: string, node: BookmarkNode): Promise<void> {
  return putNodes(profileKey, [node]);
}

export async function persistLocalChangesDb(
  profileKey: string,
  entries: Array<{ node: BookmarkNode; operation: SyncOperation }>,
  meta: SyncMeta
): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction(['nodes', 'operations', 'meta'], 'readwrite');
  const nodeStore = transaction.objectStore('nodes');
  const operationStore = transaction.objectStore('operations');
  const existingById = new Map<string, StoredOperation>();
  const operationRequest = operationStore.index('profileKey').getAll(profileKey);
  await new Promise<void>((resolve, reject) => {
    operationRequest.onsuccess = () => {
      for (const operation of operationRequest.result as StoredOperation[]) existingById.set(operation.nodeId, operation);
      for (const entry of entries) {
        nodeStore.put({ ...entry.node, profileKey } satisfies StoredNode);
        const existing = existingById.get(entry.operation.nodeId);
        const action = existing?.action === 'create' && entry.operation.action === 'update' ? 'create' : entry.operation.action;
        operationStore.put({
          ...entry.operation,
          id: existing?.id ?? entry.operation.id,
          action,
          queuedAt: existing?.queuedAt ?? entry.operation.queuedAt,
          attempts: 0,
          lastAttemptAt: undefined,
          nextRetryAt: undefined,
          lastError: undefined
        } satisfies StoredOperation);
      }
      transaction.objectStore('meta').put(meta);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('本地数据事务已回滚。'));
  });
  database.close();
}

export async function removeNodes(profileKey: string, nodeIds: string[]): Promise<void> {
  if (!nodeIds.length) return;
  const database = await openDb();
  const transaction = database.transaction('nodes', 'readwrite');
  const store = transaction.objectStore('nodes');
  for (const nodeId of nodeIds) store.delete([profileKey, nodeId]);
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function clearNodes(profileKey: string): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction('nodes', 'readwrite');
  const index = transaction.objectStore('nodes').index('profileKey');
  const keys = await requestResult<IDBValidKey[]>(index.getAllKeys(profileKey));
  const store = transaction.objectStore('nodes');
  for (const key of keys) {
    store.delete(key);
  }
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function clearProfile(profileKey: string): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction(['nodes', 'operations'], 'readwrite');
  const nodeStore = transaction.objectStore('nodes');
  const operationStore = transaction.objectStore('operations');
  const nodeKeys = await requestResult<IDBValidKey[]>(nodeStore.index('profileKey').getAllKeys(profileKey));
  const operationKeys = await requestResult<IDBValidKey[]>(operationStore.index('profileKey').getAllKeys(profileKey));
  for (const key of nodeKeys) nodeStore.delete(key);
  for (const key of operationKeys) operationStore.delete(key);
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function getOperations(profileKey: string): Promise<SyncOperation[]> {
  const database = await openDb();
  const transaction = database.transaction('operations', 'readonly');
  const index = transaction.objectStore('operations').index('profileAndQueuedAt');
  const range = IDBKeyRange.bound([profileKey, 0], [profileKey, Number.MAX_SAFE_INTEGER]);
  const records = await requestResult<StoredOperation[]>(index.getAll(range));
  database.close();
  return records;
}

export async function putOperation(operation: SyncOperation): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction('operations', 'readwrite');
  transaction.objectStore('operations').put({ ...operation } satisfies StoredOperation);
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function removeOperations(profileKey: string): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction('operations', 'readwrite');
  const index = transaction.objectStore('operations').index('profileKey');
  const keys = await requestResult<IDBValidKey[]>(index.getAllKeys(profileKey));
  const store = transaction.objectStore('operations');
  for (const key of keys) {
    store.delete(key);
  }
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function removeOperationsByIds(operationIds: string[]): Promise<void> {
  if (!operationIds.length) return;
  const database = await openDb();
  const transaction = database.transaction('operations', 'readwrite');
  const store = transaction.objectStore('operations');
  for (const operationId of operationIds) store.delete(operationId);
  await requestResult(transactionDone(transaction));
  database.close();
}

export async function getMeta(profileKey: string): Promise<SyncMeta> {
  const database = await openDb();
  const transaction = database.transaction('meta', 'readonly');
  const result = await requestResult<SyncMeta | undefined>(transaction.objectStore('meta').get(profileKey));
  database.close();
  return result ?? { profileKey, syncStatus: 'idle' };
}

export async function putMeta(meta: SyncMeta): Promise<void> {
  const database = await openDb();
  const transaction = database.transaction('meta', 'readwrite');
  transaction.objectStore('meta').put(meta);
  await requestResult(transactionDone(transaction));
  database.close();
}

function transactionDone(transaction: IDBTransaction): IDBRequest<void> {
  const request = { result: undefined } as unknown as IDBRequest<void>;
  transaction.oncomplete = () => request.onsuccess?.(new Event('success') as unknown as Event);
  transaction.onerror = () => request.onerror?.(new Event('error') as unknown as Event);
  return request;
}
