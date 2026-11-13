// One IndexedDB database for everything the app keeps per browser:
// analysed song segments and the record of every practice attempt.
const DB_NAME = 'pronunciation-test';
const VERSION = 2;

export const SONGS = 'songs';
export const ATTEMPTS = 'attempts';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SONGS)) db.createObjectStore(SONGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ATTEMPTS)) {
        db.createObjectStore(ATTEMPTS, { keyPath: 'id' }).createIndex('item', 'item');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB를 열 수 없어요.'));
  });
}

// Runs `run` in one transaction over `stores` and resolves with the result of
// the request it returns once the transaction has committed.
export async function tx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: (t: IDBTransaction) => IDBRequest<T> | void,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const req = run(t);
      t.oncomplete = () => resolve(req ? req.result : (undefined as T));
      t.onerror = () => reject(t.error ?? req?.error ?? new Error('저장소 작업에 실패했어요.'));
      t.onabort = () => reject(t.error ?? new Error('저장소 작업이 취소됐어요.'));
    });
  } finally {
    // Closing right away keeps a later version upgrade from being blocked.
    db.close();
  }
}
