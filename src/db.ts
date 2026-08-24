import type { BookmarkNode, SyncMeta, SyncOperation } from './types';

const DB_NAME = 'bookmark-manager-local';
const DB_VERSION = 1;

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
    const nodes = database.createObjectStore('nodes', { keyPath: ['profileKey', 'id'] });
    nodes.createIndex('profileKey', 'profileKey');
    const operations = database.createObjectStore('operations', { keyPath: 'id' });
    operations.createIndex('profileKey', 'profileKey');
    operations.createIndex('profileAndQueuedAt', ['profileKey', 'queuedAt']);
    database.createObjectStore('meta', { keyPath: 'profileKey' });
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

export async function putNode(profileKey: string, node: BookmarkNode): Promise<void> {
  return putNodes(profileKey, [node]);
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
