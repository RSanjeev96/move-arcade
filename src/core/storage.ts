/** Tiny IndexedDB wrapper. Everything stays on this device. */
const DB_NAME = 'move-arcade';
const VERSION = 1;
const STORES = ['songs', 'analysis', 'scores'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return run<T | undefined>(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
  },
  put(store: StoreName, key: string, value: unknown): Promise<void> {
    return run<void>(store, 'readwrite', (s) => s.put(value, key)).catch(() => undefined);
  },
  del(store: StoreName, key: string): Promise<void> {
    return run<void>(store, 'readwrite', (s) => s.delete(key)).catch(() => undefined);
  },
  all<T>(store: StoreName): Promise<T[]> {
    return run<T[]>(store, 'readonly', (s) => s.getAll()).catch(() => []);
  },
};

/** localStorage that never throws (private mode, blocked storage). */
export const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? { ...fallback, ...JSON.parse(v) } : fallback;
    } catch {
      return fallback;
    }
  },
  getRaw<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};
