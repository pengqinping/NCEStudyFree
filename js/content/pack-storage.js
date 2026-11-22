/**
 * 已安装资源包的存储适配器。
 *
 * Web 端使用 IndexedDB（无外部依赖）；Tauri Android/macOS 端将注入基于
 * 文件系统的同名接口，PackManager 不感知差异。
 *
 * 接口约定：
 *   putFile(packId, path, text)      写入（覆盖）
 *   getFile(packId, path) -> string|null
 *   deletePack(packId)               删除整个包
 *   listPackFiles(packId) -> string[]
 */

const DB_NAME = 'nce-study-packs';
const DB_VERSION = 1;
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result = null;
      try {
        result = run(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
    });
  } finally {
    db.close();
  }
}

/** IndexedDB 实现。 */
export class IdbPackStorage {
  async putFile(packId, path, text) {
    await withStore('readwrite', (store) => store.put(String(text), `${packId}/${path}`));
  }

  async getFile(packId, path) {
    const value = await withStore('readonly', (store) => store.get(`${packId}/${path}`));
    return typeof value === 'string' ? value : null;
  }

  async deletePack(packId) {
    await withStore('readwrite', (store) => {
      const prefix = `${packId}/`;
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, false);
      const cursorRequest = store.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      return cursorRequest;
    });
  }

  async listPackFiles(packId) {
    const prefix = `${packId}/`;
    const keys = await withStore('readonly', (store) =>
      requestToPromise(store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, false))),
    );
    return (keys || [])
      .filter((key) => typeof key === 'string' && key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}

/** 内存实现：单测与 IndexedDB 不可用时的兜底（仅会话内有效）。 */
export class MemoryPackStorage {
  constructor() {
    this.files = new Map();
  }

  async putFile(packId, path, text) {
    this.files.set(`${packId}/${path}`, String(text));
  }

  async getFile(packId, path) {
    return this.files.has(`${packId}/${path}`) ? this.files.get(`${packId}/${path}`) : null;
  }

  async deletePack(packId) {
    const prefix = `${packId}/`;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
  }

  async listPackFiles(packId) {
    const prefix = `${packId}/`;
    return [...this.files.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}

/** 创建当前环境的存储适配器：Tauri 壳 > IndexedDB > 内存兜底。 */
export async function createPackStorage({ onWarn = () => {} } = {}) {
  if (typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)) {
    try {
      const { TauriPackStorage } = await import('./pack-storage-tauri.js');
      const storage = new TauriPackStorage();
      await storage.putFile('__probe__', 'probe.txt', '1');
      await storage.deletePack('__probe__');
      return storage;
    } catch (error) {
      onWarn(`原生资源包存储不可用（${error?.message || error}），回退到 WebView 存储`);
    }
  }
  try {
    if (typeof indexedDB !== 'undefined') {
      const storage = new IdbPackStorage();
      await openDb();
      return storage;
    }
  } catch (error) {
    onWarn(`IndexedDB 不可用（${error?.message || error}），资源包仅本次会话有效`);
  }
  return new MemoryPackStorage();
}
