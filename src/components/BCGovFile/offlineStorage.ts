import { getBestStorageStrategy } from '../Common/utils';

export type OfflineStorageStrategy = 'indexeddb' | 'localstorage' | 'none';

/**
 * Stored alongside each file so it can be matched back to its form/component after the window is closed.
 */
export interface OfflineFileMeta {
  offlineKey: string;
  /** Submission the file belongs to (host-provided offlineScope, else the loaded submission's _id; '' for a new submission, so never restored). */
  scope: string;
  componentPath: string;
  /** Who added it ('' for anonymous); it is only uploaded as them. Absent when the provider can't tell. */
  userId?: string;
  name: string;
  originalName: string;
  dir?: string;
  size: number;
  type: string;
  hash?: string;
  createdAt: number;
  /**
   * Set once the file is uploaded: the server's fileInfo. The contents are dropped but this record
   * is kept, so a saved draft that still holds the placeholder can be given the uploaded file.
   */
  uploaded?: any;
  uploadedAt?: number;
}

const DB_NAME = 'bcgov-formio-offline-files';
const STORE_NAME = 'files';
const LS_PREFIX = 'bcgov-formio-offline-file:';
const LS_META_PREFIX = 'bcgov-formio-offline-file-meta:';
/**
 * Largest file kept in localStorage. Its quota is around 5MB per origin and a data URL is about 1.33
 * times the file, so anything bigger would fail anyway, after reading the whole file into memory as
 * base64. Larger files are refused up front and upload() sends them directly instead.
 */
export const LOCAL_STORAGE_MAX_FILE_BYTES = 3 * 1024 * 1024;

let strategyPromise: Promise<OfflineStorageStrategy> | null = null;
let persistRequested = false;

/**
 * Resolve (and cache) the best available offline storage for this browser.
 */
export function getOfflineStorageStrategy(): Promise<OfflineStorageStrategy> {
  if (!strategyPromise) {
    strategyPromise = getBestStorageStrategy() as Promise<OfflineStorageStrategy>;
  }
  return strategyPromise;
}

/**
 * RFC 4122 v4 UUID. crypto.randomUUID is only exposed in secure contexts, so fall back to getRandomValues.
 */
export function createOfflineKey(): string {
  const c: any = typeof crypto !== 'undefined' ? crypto : undefined;
  if (typeof c?.randomUUID === 'function') {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // tslint:disable-next-line:no-bitwise
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // tslint:disable-next-line:no-bitwise
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Ask the browser not to evict our storage under pressure. Only asked once per page load; the
 * browser may grant or deny silently, and we carry on either way.
 */
export function requestPersistentStorage() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    const storage: any = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (typeof storage?.persist === 'function') {
      storage.persist().catch(() => undefined);
    }
  } catch (e) {
    // ignore
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbRequest<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = fn(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/**
 * Persist a file's contents locally so it can be uploaded once the browser is back online.
 * An IndexedDB failure (quota, blocked, disabled since the strategy was picked) falls back to
 * localStorage. Resolves to the storage actually used.
 */
export async function saveOfflineFile(
  strategy: OfflineStorageStrategy,
  file: Blob,
  meta: OfflineFileMeta,
): Promise<OfflineStorageStrategy> {
  const key = meta.offlineKey;
  if (strategy === 'indexeddb') {
    try {
      await idbRequest('readwrite', (store) => store.put({ key, blob: file, meta }));
      return 'indexeddb';
    } catch (e) {
      try {
        return await saveOfflineFile('localstorage', file, meta);
      } catch {
        throw e;
      }
    }
  }
  if (strategy === 'localstorage') {
    if (file.size > LOCAL_STORAGE_MAX_FILE_BYTES) {
      throw Object.assign(new Error('the file is too large to keep in this browser'), { code: 'too-large' });
    }
    const dataUrl = await blobToDataUrl(file);
    // Throws QuotaExceededError when the file is too large for localStorage
    window.localStorage.setItem(LS_PREFIX + key, dataUrl);
    try {
      window.localStorage.setItem(LS_META_PREFIX + key, JSON.stringify(meta));
    } catch (e) {
      window.localStorage.removeItem(LS_PREFIX + key);
      throw e;
    }
    return 'localstorage';
  }
  throw new Error('No offline storage is available in this browser.');
}

export interface OfflineFileRecord {
  /** The contents; null once uploaded (see meta.uploaded). */
  blob: Blob | null;
  meta: OfflineFileMeta;
}

/**
 * The stored file, or null when it isn't there (including when this browser has no such storage at
 * all). Rejects when the storage exists but the read fails.
 */
export async function getOfflineFile(strategy: OfflineStorageStrategy, key: string): Promise<OfflineFileRecord | null> {
  if (strategy === 'indexeddb') {
    if (typeof window === 'undefined' || !('indexedDB' in window) || !window.indexedDB) {
      return null;
    }
    const record: any = await idbRequest('readonly', (store) => store.get(key));
    if (record?.meta?.uploaded) {
      return { blob: null, meta: record.meta };
    }
    return record?.blob ? { blob: record.blob, meta: record.meta } : null;
  }
  if (strategy === 'localstorage') {
    if (typeof window === 'undefined' || !('localStorage' in window) || !window.localStorage) {
      return null;
    }
    const metaJson = window.localStorage.getItem(LS_META_PREFIX + key);
    if (!metaJson) {
      return null;
    }
    const meta: OfflineFileMeta = JSON.parse(metaJson);
    if (meta.uploaded) {
      return { blob: null, meta };
    }
    const dataUrl = window.localStorage.getItem(LS_PREFIX + key);
    return dataUrl ? { blob: await dataUrlToBlob(dataUrl), meta } : null;
  }
  return null;
}

export interface OfflineFileListing {
  meta: OfflineFileMeta;
  strategy: OfflineStorageStrategy;
}

/**
 * List the metadata of every stored file in either store (without loading file contents for
 * localStorage). Both are read since a file can fall back to localStorage when IndexedDB fails.
 */
export async function listOfflineFiles(): Promise<OfflineFileListing[]> {
  const listings: OfflineFileListing[] = [];
  try {
    const records: any[] = await idbRequest('readonly', (store) => store.getAll());
    (records || [])
      .filter((r) => r?.meta)
      .forEach((r) => listings.push({ meta: r.meta, strategy: 'indexeddb' }));
  } catch (e) {
    // IndexedDB unavailable
  }
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const lsKey = window.localStorage.key(i);
      if (!lsKey?.startsWith(LS_META_PREFIX)) continue;
      try {
        listings.push({ meta: JSON.parse(window.localStorage.getItem(lsKey)), strategy: 'localstorage' });
      } catch (e) {
        // ignore corrupt entries
      }
    }
  } catch (e) {
    // localStorage unavailable
  }
  return listings;
}

/**
 * Change a stored file's metadata (e.g. its componentPath after a DataGrid row moved). Resolves
 * false when the file isn't stored.
 */
export async function updateOfflineFileMeta(
  strategy: OfflineStorageStrategy,
  key: string,
  changes: Partial<OfflineFileMeta>,
): Promise<boolean> {
  if (strategy === 'indexeddb') {
    const db = await openDb();
    try {
      // Read and write in one transaction so a concurrent delete can't be undone by the put
      return await new Promise<boolean>((resolve, reject) => {
        let found = false;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result) {
            found = true;
            store.put({ ...request.result, meta: { ...request.result.meta, ...changes } });
          }
        };
        tx.oncomplete = () => resolve(found);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  if (strategy === 'localstorage') {
    const metaJson = window.localStorage.getItem(LS_META_PREFIX + key);
    if (!metaJson) {
      return false;
    }
    window.localStorage.setItem(LS_META_PREFIX + key, JSON.stringify({ ...JSON.parse(metaJson), ...changes }));
    return true;
  }
  return false;
}

/**
 * Record that a stored file was uploaded: drop its contents and keep its metadata with the server's
 * fileInfo. Resolves false when the file isn't stored.
 */
export async function markOfflineFileUploaded(
  strategy: OfflineStorageStrategy,
  key: string,
  uploaded: any,
): Promise<boolean> {
  if (strategy === 'indexeddb') {
    const db = await openDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        let found = false;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result) {
            found = true;
            store.put({ key, blob: null, meta: { ...request.result.meta, uploaded, uploadedAt: Date.now() } });
          }
        };
        tx.oncomplete = () => resolve(found);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  if (strategy === 'localstorage') {
    const metaJson = window.localStorage.getItem(LS_META_PREFIX + key);
    if (!metaJson) {
      return false;
    }
    // Metadata first, so the record never looks pending without its contents
    window.localStorage.setItem(
      LS_META_PREFIX + key,
      JSON.stringify({ ...JSON.parse(metaJson), uploaded, uploadedAt: Date.now() }),
    );
    window.localStorage.removeItem(LS_PREFIX + key);
    return true;
  }
  return false;
}

export async function deleteOfflineFile(strategy: OfflineStorageStrategy, key: string) {
  if (strategy === 'indexeddb') {
    await idbRequest('readwrite', (store) => store.delete(key));
  } else if (strategy === 'localstorage') {
    window.localStorage.removeItem(LS_PREFIX + key);
    window.localStorage.removeItem(LS_META_PREFIX + key);
  }
}
