/**
 * 资源包管理器：内置包读取、包安装（zip/.ncepack）、版本注册、更新检查。
 *
 * 内容来源两级：
 *   - 内置包：随应用分发在 `./data/packs/<packId>/`，通过 fetch 读取（SW 离线缓存）
 *   - 已安装包：写入 PackStorage（Web=IndexedDB；Tauri 端=文件系统适配器）
 *
 * 安装包格式 `.ncepack` = zip，根目录即包内容（manifest.json + content/ + …）。
 */

import { validateManifest, validatePackFiles, compareVersions } from './pack-format.js';
import { unzipSync } from '../vendor/fflate.js';

export const REGISTRY_KEY = 'nce-study:packs:v1';
const CATALOG_URL_KEY = 'nce-study:packs:catalog-url';
const AUTO_CHECK_KEY = 'nce-study:packs:auto-check';
export const DEFAULT_CATALOG_URL = './data/catalog.json';

/** 目录源 URL：默认取应用内目录，可指向远端（如 GitHub Pages / 自建静态目录）。 */
export function getCatalogUrl(localStorageRef = globalThis.localStorage) {
  try {
    return localStorageRef?.getItem(CATALOG_URL_KEY) || DEFAULT_CATALOG_URL;
  } catch {
    return DEFAULT_CATALOG_URL;
  }
}

export function setCatalogUrl(url, localStorageRef = globalThis.localStorage) {
  const value = String(url || '').trim();
  try {
    if (!value || value === DEFAULT_CATALOG_URL) localStorageRef?.removeItem(CATALOG_URL_KEY);
    else localStorageRef?.setItem(CATALOG_URL_KEY, value);
  } catch {
    /* 存储不可用时忽略 */
  }
  return value;
}

/** 启动时自动检查资源包更新（可在设置中关闭）。 */
export function isAutoCheckEnabled(localStorageRef = globalThis.localStorage) {
  try {
    return localStorageRef?.getItem(AUTO_CHECK_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAutoCheckEnabled(enabled, localStorageRef = globalThis.localStorage) {
  try {
    localStorageRef?.setItem(AUTO_CHECK_KEY, enabled ? '1' : '0');
  } catch {
    /* 忽略 */
  }
  return Boolean(enabled);
}

function textDecoder() {
  return new TextDecoder('utf-8');
}

/** 稳定 SHA-256（HTTPS/localhost 下可用；不可用时跳过校验并告警）。 */
async function sha256Hex(bytes, cryptoImpl) {
  if (!cryptoImpl?.subtle) return null;
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 从 zip 字节中解出 {相对路径: 文本}。跳过目录项与多余负路径。 */
function unzipToText(bytes) {
  const entries = unzipSync(new Uint8Array(bytes));
  const decoder = textDecoder();
  const files = new Map();
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/')) continue;
    files.set(path, decoder.decode(data));
  }
  return files;
}

export class PackManager {
  constructor({
    bundledIndexUrl = './data/packs/bundled.json',
    storage,
    localStorageRef = globalThis.localStorage,
    fetchImpl = (...args) => fetch(...args),
    cryptoImpl = globalThis.crypto,
    appVersion = '0.0.0',
  } = {}) {
    this.bundledIndexUrl = bundledIndexUrl;
    this.storage = storage;
    this.localStorageRef = localStorageRef;
    this.fetchImpl = fetchImpl;
    this.cryptoImpl = cryptoImpl;
    this.appVersion = appVersion;
    this.bundled = []; // [{packId, version, base}]
    this.installed = new Map(); // packId -> {packId, version, source, installedAt, sha256, size}
    this.cache = new Map(); // packId -> {manifest, books:Map, units:Map unitId->unit, searchIndex}
    this.listeners = new Set();
    this._booksCache = null;
    this._searchCache = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, detail = null) {
    this._booksCache = null;
    this._searchCache = null;
    for (const listener of this.listeners) {
      try {
        listener({ type, detail });
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
  }

  // ---------- 初始化 ----------

  async init() {
    this.installed = this.loadRegistry();
    try {
      const response = await this.fetchImpl(this.bundledIndexUrl);
      if (response.ok) {
        const data = await response.json();
        this.bundled = Array.isArray(data?.packs) ? data.packs : [];
      }
    } catch {
      this.bundled = [];
    }
    await Promise.all(
      this.bundled.map(async (entry) => {
        try {
          await this.loadManifest(entry.packId);
        } catch (error) {
          console.warn(`内置资源包加载失败：${entry.packId}`, error);
        }
      }),
    );
    await Promise.all(
      [...this.installed.keys()].map(async (packId) => {
        try {
          await this.loadManifest(packId);
        } catch (error) {
          console.warn(`已安装资源包读取失败：${packId}`, error);
        }
      }),
    );
  }

  loadRegistry() {
    try {
      const raw = this.localStorageRef?.getItem(REGISTRY_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const map = new Map();
      for (const entry of Object.values(parsed?.packs || {})) {
        if (entry?.packId && typeof entry.version === 'string') map.set(entry.packId, entry);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  saveRegistry() {
    try {
      this.localStorageRef?.setItem(
        REGISTRY_KEY,
        JSON.stringify({ version: 1, packs: Object.fromEntries(this.installed) }),
      );
    } catch (error) {
      console.warn('资源包注册表保存失败', error);
    }
  }

  // ---------- 内容读取 ----------

  isBundled(packId) {
    return this.bundled.some((entry) => entry.packId === packId);
  }

  bundledEntry(packId) {
    return this.bundled.find((entry) => entry.packId === packId) || null;
  }

  /** 内置包且未被已安装副本覆盖时走 fetch；否则走 storage。 */
  async #readFile(packId, path) {
    const installedCopy = this.installed.has(packId);
    if (!installedCopy && this.isBundled(packId)) {
      const base = this.bundledEntry(packId).base;
      const response = await this.fetchImpl(`${base}/${path}`);
      if (!response.ok) throw new Error(`资源包文件不存在：${packId}/${path}`);
      return response.text();
    }
    const text = await this.storage.getFile(packId, path);
    if (text === null) throw new Error(`资源包文件不存在：${packId}/${path}`);
    return text;
  }

  async loadManifest(packId) {
    if (this.cache.has(packId)) return this.cache.get(packId).manifest;
    const raw = await this.#readFile(packId, 'manifest.json');
    const manifest = JSON.parse(raw);
    const errors = validateManifest(manifest);
    if (errors.length) throw new Error(`资源包 manifest 非法：${errors[0]}`);
    this.cache.set(packId, { manifest, books: new Map(), units: new Map(), searchIndex: null });
    return manifest;
  }

  async #loadBook(packId, bookId) {
    const pack = this.cache.get(packId);
    const manifest = pack.manifest;
    const bookEntry = manifest.books.find((book) => book.id === Number(bookId));
    if (!bookEntry) return null;
    const book = JSON.parse(await this.#readFile(packId, bookEntry.entry));
    if (book?.id !== bookEntry.id) throw new Error(`资源包数据不一致：${packId} book${bookEntry.id}`);
    pack.books.set(bookEntry.id, book);
    return book;
  }

  /** 单册数据（含单元摘要列表）。 */
  async loadBook(bookId) {
    const id = Number(bookId);
    for (const [packId, pack] of this.cache) {
      if (!pack.manifest.books.some((book) => book.id === id)) continue;
      if (!pack.books.has(id)) await this.#loadBook(packId, id);
      const book = pack.books.get(id);
      return { ...book, packId, source: packId };
    }
    return null;
  }

  /** 完整单元数据（按需加载）。 */
  async loadUnit(bookId, unitId) {
    const id = Number(bookId);
    for (const [packId, pack] of this.cache) {
      if (!pack.manifest.books.some((book) => book.id === id)) continue;
      if (!pack.books.has(id)) await this.#loadBook(packId, id);
      const book = pack.books.get(id);
      if (!book?.units?.some((unit) => unit.id === unitId)) return null;
      const entry = book.units.find((unit) => unit.id === unitId);
      const relativeDir = `content/book${id}/units`;
      const fileName = `u${String(entry.unit).padStart(2, '0')}.json`;
      const unit = JSON.parse(await this.#readFile(packId, `${relativeDir}/${fileName}`));
      pack.units.set(unitId, unit);
      return unit;
    }
    return null;
  }

  /** 同步缓存读取（需先 loadBook/loadUnit）。 */
  getBookMeta(bookId) {
    const books = this.listBooks();
    return books.find((book) => book.id === Number(bookId)) || null;
  }

  /** 已加载册的单元摘要数组（同步）。 */
  getBookUnits(bookId) {
    const id = Number(bookId);
    for (const pack of this.cache.values()) {
      const book = pack.books.get(id);
      if (book) return book.units || [];
    }
    return [];
  }

  getUnit(bookId, unitId) {
    const id = Number(bookId);
    for (const pack of this.cache.values()) {
      const book = pack.books.get(id);
      if (book) return pack.units.get(unitId) || null;
    }
    return null;
  }

  /** 合并所有可见包的册列表；同 book.key 冲突时取包版本更高者。 */
  listBooks() {
    if (this._booksCache) return this._booksCache;
    const byKey = new Map();
    for (const [packId, pack] of this.cache) {
      for (const book of pack.manifest.books) {
        const existing = byKey.get(book.key);
        const entry = { ...book, packId };
        if (!existing || compareVersions(this.versionOf(packId), this.versionOf(existing.packId)) >= 0) {
          byKey.set(book.key, entry);
        }
      }
    }
    this._booksCache = [...byKey.values()].sort((a, b) => a.id - b.id);
    return this._booksCache;
  }

  /** 合并搜索索引。 */
  async loadSearchIndex() {
    if (this._searchCache) return this._searchCache;
    const parts = [];
    for (const packId of this.cache.keys()) {
      try {
        const index = JSON.parse(await this.#readFile(packId, 'search-index.json'));
        if (Array.isArray(index)) parts.push(...index);
      } catch (error) {
        console.warn(`搜索索引读取失败：${packId}`, error);
      }
    }
    this._searchCache = parts;
    return this._searchCache;
  }

  versionOf(packId) {
    return this.installed.get(packId)?.version || this.bundledEntry(packId)?.version || null;
  }

  sourceOf(packId) {
    if (this.installed.has(packId)) return this.installed.get(packId).source || 'installed';
    if (this.isBundled(packId)) return 'bundled';
    return null;
  }

  /** 设置页展示用：所有可见包及其版本/来源。 */
  listPacks() {
    const packs = [];
    for (const entry of this.bundled) {
      const installedCopy = this.installed.get(entry.packId);
      packs.push({
        packId: entry.packId,
        version: installedCopy?.version || entry.version,
        bundledVersion: entry.version,
        source: installedCopy ? 'installed' : 'bundled',
        name: this.cache.get(entry.packId)?.manifest?.name || entry.packId,
        bookCount: this.cache.get(entry.packId)?.manifest?.books?.length || 0,
        size: installedCopy?.size || null,
        installedAt: installedCopy?.installedAt || null,
      });
    }
    for (const [packId, entry] of this.installed) {
      if (this.isBundled(packId)) continue;
      packs.push({
        packId,
        version: entry.version,
        bundledVersion: null,
        source: entry.source || 'installed',
        name: this.cache.get(packId)?.manifest?.name || packId,
        bookCount: this.cache.get(packId)?.manifest?.books?.length || 0,
        size: entry.size || null,
        installedAt: entry.installedAt || null,
      });
    }
    return packs;
  }

  // ---------- 安装 / 更新 / 删除 ----------

  async installFromBuffer(buffer, { expectedSha256 = null, source = 'import' } = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (expectedSha256) {
      const hex = await sha256Hex(bytes, this.cryptoImpl);
      if (hex && hex.toLowerCase() !== String(expectedSha256).toLowerCase()) {
        throw new Error('资源包校验失败：SHA-256 与目录记录不一致');
      }
    }
    const files = unzipToText(bytes);
    if (!files.has('manifest.json')) throw new Error('资源包缺少 manifest.json');
    const manifest = JSON.parse(files.get('manifest.json'));
    const errors = [...validateManifest(manifest), ...validatePackFiles(manifest, [...files.keys()])];
    if (errors.length) throw new Error(`资源包非法：${errors[0]}`);
    if (manifest.minAppVersion && compareVersions(this.appVersion, manifest.minAppVersion) < 0) {
      throw new Error(`需要应用版本 ≥ ${manifest.minAppVersion}，当前 ${this.appVersion}`);
    }
    const packId = manifest.packId;
    for (const [path, text] of files) {
      await this.storage.putFile(packId, path, text);
    }
    this.installed.set(packId, {
      packId,
      version: manifest.version,
      source,
      installedAt: Date.now(),
      sha256: (await sha256Hex(bytes, this.cryptoImpl)) || expectedSha256 || '',
      size: bytes.byteLength,
    });
    this.saveRegistry();
    this.cache.delete(packId);
    await this.loadManifest(packId);
    this.emit('packsChanged', { packId, version: manifest.version });
    return manifest;
  }

  async installFromUrl(url, expected) {
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    return this.installFromBuffer(buffer, {
      expectedSha256: expected?.sha256 || null,
      source: 'download',
    });
  }

  async installFromFile(file) {
    const buffer = await file.arrayBuffer();
    return this.installFromBuffer(buffer, { source: 'import' });
  }

  async removePack(packId) {
    if (!this.installed.has(packId)) return false;
    await this.storage.deletePack(packId);
    this.installed.delete(packId);
    this.saveRegistry();
    this.cache.delete(packId);
    this.emit('packsChanged', { packId, removed: true });
    return true;
  }

  /**
   * 检查更新。catalogUrl 返回 { packs: [{packId, version, url, sha256, size}] }。
   * 返回 { updates, available }：updates 为比当前版本更高的包，available 为全部目录条目。
   */
  async checkUpdates(catalogUrl = './data/catalog.json') {
    const response = await this.fetchImpl(catalogUrl);
    if (!response.ok) throw new Error(`获取目录失败：HTTP ${response.status}`);
    const catalog = await response.json();
    const entries = Array.isArray(catalog?.packs) ? catalog.packs : [];
    const updates = entries.filter((entry) => {
      const current = this.versionOf(entry.packId);
      return !current || compareVersions(entry.version, current) > 0;
    });
    return { updates, available: entries, generatedAt: catalog.generatedAt || null };
  }
}
