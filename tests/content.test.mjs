import test from 'node:test';
import assert from 'node:assert/strict';
import { toContentId, unitContentId, unitFileName, parseContentId } from '../js/content/content-id.js';
import { validateManifest, isSafePackPath, compareVersions, PACK_SCHEMA_VERSION } from '../js/content/pack-format.js';
import { PackManager } from '../js/content/pack-manager.js';
import { MemoryPackStorage } from '../js/content/pack-storage.js';
import { Store } from '../js/store.js';
import { zipSync, strToU8 } from '../js/vendor/fflate.js';

class MemoryStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

test('toContentId：旧课号 → 稳定内容 ID，且幂等', () => {
  assert.equal(toContentId('b1-u01'), 'nce1:u01');
  assert.equal(toContentId('b4-u48'), 'nce4:u48');
  assert.equal(toContentId('b1-u01-q02'), 'nce1:u01-q02');
  assert.equal(toContentId('b1-u01:handbag'), 'nce1:u01:handbag');
  assert.equal(toContentId('nce1:u01'), 'nce1:u01');
  assert.equal(toContentId('other'), 'other');
  assert.equal(toContentId(null), null);
});

test('unitContentId / unitFileName / parseContentId 互逆', () => {
  const id = unitContentId('NCE2', 7);
  assert.equal(id, 'nce2:u07');
  assert.equal(unitFileName(id), 'u07.json');
  const parsed = parseContentId(id);
  assert.equal(parsed.key, 'NCE2');
  assert.equal(parsed.bookNumber, 2);
  assert.equal(parsed.unitNumber, 7);
  assert.equal(unitFileName('b1-u01'), null);
});

test('isSafePackPath 拒绝绝对路径与目录穿越', () => {
  assert.ok(isSafePackPath('content/book1/units/u01.json'));
  assert.equal(isSafePackPath('/absolute/path.json'), false);
  assert.equal(isSafePackPath('content/../secret.json'), false);
  assert.equal(isSafePackPath('a//b.json'), false);
  assert.equal(isSafePackPath('back\\slash.json'), false);
  assert.equal(isSafePackPath(''), false);
});

function validManifest() {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    packId: 'demo-pack',
    name: '演示包',
    version: '1.0.0',
    books: [{ id: 1, key: 'NCE1', entry: 'content/book1/book.json', units: 2 }],
  };
}

test('validateManifest：合法与非法清单', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
  const bad = validateManifest({ ...validManifest(), schemaVersion: 99, version: 'abc' });
  assert.equal(bad.length >= 2, true);
  assert.equal(validateManifest(null).length, 1);
  const badEntry = validateManifest({ ...validManifest(), books: [{ id: 1, key: 'NCE1', entry: '../x.json', units: 1 }] });
  assert.equal(badEntry.length, 1);
});

test('compareVersions：semver 比较', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

/** 构造一个最小 .ncepack 字节流。 */
function makePackBytes({ packId = 'demo-pack', version = '1.0.0' } = {}) {
  const manifest = { ...validManifest(), packId, version };
  const book = {
    id: 1,
    key: 'NCE1',
    units: [{ id: 'b1-u01', contentId: 'nce1:u01', book: 1, unit: 1, lessonFrom: 1, lessonTo: 2, title: 'Demo' }],
  };
  const unit = {
    ...book.units[0],
    sentences: [{ en: 'Hello.', zh: '你好。' }],
    vocab: [{ word: 'hello', meanings: [{ pos: 'int', meaning: '你好' }] }],
    phrases: [],
    grammar: [],
    patterns: [],
    exercises: [],
  };
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'content/book1/book.json': strToU8(JSON.stringify(book)),
      'content/book1/units/u01.json': strToU8(JSON.stringify(unit)),
      'search-index.json': strToU8(JSON.stringify([{ id: 'b1-u01', book: 1, unit: 1, title: 'Demo', words: ['hello'] }])),
    },
    { level: 0 },
  );
}

function fakeFetch(files) {
  return async (url) => {
    const path = String(url).replace(/^\.\//, '');
    if (files.has(path)) {
      const body = files.get(path);
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body),
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

function makeManager({ files = new Map(), storage = new MemoryPackStorage(), registrySeed = {} } = {}) {
  return new PackManager({
    storage,
    localStorageRef: new MemoryStorage({ 'nce-study:packs:v1': JSON.stringify({ version: 1, packs: registrySeed }) }),
    fetchImpl: fakeFetch(files),
    appVersion: '0.3.0',
  });
}

test('PackManager：安装 zip → 注册 → 加载册与单元 → 搜索索引', async () => {
  const files = new Map([['data/packs/bundled.json', JSON.stringify({ version: 1, packs: [] })]]);
  const manager = makeManager({ files });
  await manager.init();
  assert.deepEqual(manager.listPacks(), []);

  const manifest = await manager.installFromBuffer(makePackBytes(), { source: 'import' });
  assert.equal(manifest.packId, 'demo-pack');

  const books = manager.listBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].packId, 'demo-pack');

  const book = await manager.loadBook(1);
  assert.equal(book.key, 'NCE1');
  assert.equal(book.units[0].id, 'b1-u01');

  const unit = await manager.loadUnit(1, 'b1-u01');
  assert.equal(unit.sentences[0].en, 'Hello.');

  const search = await manager.loadSearchIndex();
  assert.equal(search.length, 1);

  // 重启后注册表仍在，manifest 从同一 storage 读取
  const files2 = new Map([['data/packs/bundled.json', JSON.stringify({ version: 1, packs: [] })]]);
  const storage2 = manager.storage;
  const manager2 = makeManager({ files: files2, storage: storage2, registrySeed: Object.fromEntries(manager.installed) });
  await manager2.init();
  assert.equal(manager2.listBooks().length, 1);
  assert.equal(manager2.sourceOf('demo-pack'), 'import');
});

test('PackManager：SHA-256 校验失败会拒绝安装', async () => {
  const manager = makeManager();
  await assert.rejects(
    () => manager.installFromBuffer(makePackBytes(), { expectedSha256: '0'.repeat(64) }),
    /校验失败/,
  );
});

test('PackManager：内置包可被更高版本安装副本覆盖，更新检查产出升级项', async () => {
  const bundledBase = 'data/packs/demo-pack';
  const files = new Map([
    ['data/packs/bundled.json', JSON.stringify({ version: 1, packs: [{ packId: 'demo-pack', version: '1.0.0', base: `./${bundledBase}` }] })],
    [`${bundledBase}/manifest.json`, JSON.stringify(validManifest())],
    [`${bundledBase}/content/book1/book.json`, JSON.stringify({ id: 1, key: 'NCE1', units: [{ id: 'b1-u01', book: 1, unit: 1, title: 'Bundled' }] })],
    [`${bundledBase}/content/book1/units/u01.json`, JSON.stringify({ id: 'b1-u01', unit: 1, sentences: [{ en: 'Bundled.' }] })],
    [`${bundledBase}/search-index.json`, '[]'],
    [
      'data/catalog.json',
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        packs: [{ packId: 'demo-pack', version: '1.1.0', url: './dist/demo-pack.ncepack', sha256: null, size: 10 }],
      }),
    ],
  ]);
  const manager = makeManager({ files });
  await manager.init();
  assert.equal(manager.listPacks().length, 1);
  assert.equal(manager.sourceOf('demo-pack'), 'bundled');

  const { updates } = await manager.checkUpdates();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].version, '1.1.0');

  await manager.installFromBuffer(makePackBytes({ version: '1.1.0' }), { source: 'download' });
  assert.equal(manager.sourceOf('demo-pack'), 'download');
  const book = await manager.loadBook(1);
  assert.equal(book.units[0].title, 'Demo');

  const { updates: after } = await manager.checkUpdates();
  assert.equal(after.length, 0);

  await manager.removePack('demo-pack');
  assert.equal(manager.sourceOf('demo-pack'), 'bundled');
});

test('Store：旧版 localStorage 数据自动迁移为稳定内容 ID', () => {
  const due = new Date(Date.now() + 86400000).toISOString();
  const storage = new MemoryStorage({
    'nce-study:v1': JSON.stringify({
      version: 1,
      progress: { 'b1-u01': { status: 'done', visits: 3 } },
      srs: { 'b1-u01:handbag': { word: 'handbag', due, lessonId: 'b1-u01' } },
      mistakes: { 'b1-u01-q01': { question: { id: 'b1-u01-q01' }, lessonId: 'b1-u01' } },
      notes: { 'b2-u03': 'note' },
      favorites: ['b1-u01'],
      lastLesson: 'b1-u01',
      lastLessonMeta: { id: 'b1-u01', title: 'Excuse Me' },
      daily: { '2026-01-01': { answered: 2, correct: 1, seconds: 30, lessons: ['b1-u01'] } },
    }),
  });
  const store = new Store({ storage });
  store.load();
  assert.equal(store.state.version, 2);
  assert.equal(store.state.progress['nce1:u01'].status, 'done');
  assert.equal(store.state.progress['b1-u01'], undefined);
  assert.equal(store.state.srs['nce1:u01:handbag'].lessonId, 'nce1:u01');
  assert.equal(store.state.mistakes['nce1:u01-q01'].lessonId, 'nce1:u01');
  assert.equal(store.state.notes['nce2:u03'], 'note');
  assert.deepEqual(store.state.favorites, ['nce1:u01']);
  assert.equal(store.state.lastLesson, 'nce1:u01');
  assert.equal(store.state.lastLessonMeta.id, 'nce1:u01');
  assert.deepEqual(store.state.daily['2026-01-01'].lessons, ['nce1:u01']);
  // 旧课号传参依然可用（归一化）
  assert.equal(store.getNote('b2-u03'), 'note');
  assert.equal(store.isFavorite('b1-u01'), true);
});

test('catalog URL 与自动检查开关的持久化', async () => {
  const { getCatalogUrl, setCatalogUrl, isAutoCheckEnabled, setAutoCheckEnabled, DEFAULT_CATALOG_URL } =
    await import('../js/content/pack-manager.js');
  const storage = new MemoryStorage();
  // 默认值
  assert.equal(getCatalogUrl(storage), DEFAULT_CATALOG_URL);
  assert.equal(isAutoCheckEnabled(storage), true);
  // 自定义目录
  setCatalogUrl('https://example.com/catalog.json', storage);
  assert.equal(getCatalogUrl(storage), 'https://example.com/catalog.json');
  // 恢复默认即清除记录
  setCatalogUrl(DEFAULT_CATALOG_URL, storage);
  assert.equal(getCatalogUrl(storage), DEFAULT_CATALOG_URL);
  // 自动检查开关
  setAutoCheckEnabled(false, storage);
  assert.equal(isAutoCheckEnabled(storage), false);
  setAutoCheckEnabled(true, storage);
  assert.equal(isAutoCheckEnabled(storage), true);
});
