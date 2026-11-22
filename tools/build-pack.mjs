#!/usr/bin/env node
/**
 * 构建 NCE 课程资源包。
 *
 * 输出：
 *   data/packs/bundled.json                       内置包索引（供 PackManager 启动读取）
 *   data/packs/<packId>/manifest.json             包清单
 *   data/packs/<packId>/content/bookN/book.json   册级元数据 + 单元摘要列表
 *   data/packs/<packId>/content/bookN/units/*.json 完整单元（按需加载的最小单位）
 *   data/packs/<packId>/search-index.json         包内搜索索引
 *   data/packs/<packId>/NOTICE.md                 版权声明随包分发
 *   data/catalog.json                             包目录（版本/大小/sha256/下载地址，供检查更新）
 *   dist/packs/<packId>-<version>.ncepack         分发用 zip 包
 *
 * 复用 tools/lib/units.mjs 的单元构建逻辑，与旧版 build-data.mjs 数据结构一致，
 * 仅额外为每个单元/索引条目添加稳定 contentId。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from '../js/vendor/fflate.js';
import { buildBookUnits, unitSearchEntry } from './lib/units.mjs';
import { unitContentId } from '../js/content/content-id.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'sources');
const DATA_DIR = path.join(ROOT, 'data');
const DIST_DIR = path.join(ROOT, 'dist', 'packs');

const PACK_ID = 'nce-core-1-4';
const PACK_VERSION = '1.0.0';
const PACK_NAME = '新概念英语 1–4（核心课程包）';
const APP_VERSION = '0.3.0';

const BOOKS = [
  {
    id: 1,
    key: 'NCE1',
    title: 'First Things First',
    titleZh: '英语初阶',
    level: '入门',
    color: '#b45309',
    description: '从问候、日常句型与基础语法起步，建立语音、词汇和语感。',
  },
  {
    id: 2,
    key: 'NCE2',
    title: 'Practice and Progress',
    titleZh: '实践与进步',
    level: '基础',
    color: '#1d4ed8',
    description: '系统梳理时态、从句与常见表达，听说读写同步提升。',
  },
  {
    id: 3,
    key: 'NCE3',
    title: 'Developing Skills',
    titleZh: '培养技能',
    level: '进阶',
    color: '#0f766e',
    description: '训练长句、篇章结构与地道表达，进阶阅读与写作。',
  },
  {
    id: 4,
    key: 'NCE4',
    title: 'Fluency in English',
    titleZh: '流利英语',
    level: '高阶',
    color: '#6d28d9',
    description: '阅读学术与思辨性文章，掌握复杂句、论证与流利表达。',
  },
];

const lrcCache = new Map();
async function readLrc(key) {
  if (lrcCache.has(key)) return lrcCache.get(key);
  try {
    const text = await readFile(path.join(SOURCE_DIR, 'lrc', 'NCE1', `${key}.lrc`), 'utf8');
    lrcCache.set(key, text);
    return text;
  } catch {
    lrcCache.set(key, null);
    return null;
  }
}

async function main() {
  const generatedAt = new Date().toISOString();
  const warnings = [];
  const errors = [];

  const packDir = path.join(DATA_DIR, 'packs', PACK_ID);
  await rm(packDir, { recursive: true, force: true });
  await mkdir(path.join(packDir, 'content'), { recursive: true });
  await mkdir(DIST_DIR, { recursive: true });

  const manifestBooks = [];
  const searchIndex = [];
  const unitCount = { total: 0 };

  for (const book of BOOKS) {
    const catalog = JSON.parse(
      (await readFile(path.join(SOURCE_DIR, 'books', `${book.key}.json`), 'utf8')).replace(/^\uFEFF/, ''),
    );
    const { units, meta, errors: bookErrors, warnings: bookWarnings } = await buildBookUnits(
      book,
      catalog,
      async (key) => {
        // 第二/三/四册 LRC 按册目录存放；第一册走默认
        if (book.id === 1) return readLrc(key);
        try {
          return await readFile(path.join(SOURCE_DIR, 'lrc', book.key, `${key}.lrc`), 'utf8');
        } catch {
          return readLrc(key);
        }
      },
      async (key) => {
        try {
          const text = (
            await readFile(path.join(SOURCE_DIR, 'notes', book.key, `${key}.json`), 'utf8')
          ).replace(/^\uFEFF/, '');
          return JSON.parse(text);
        } catch {
          return null;
        }
      },
    );
    errors.push(...bookErrors);
    warnings.push(...bookWarnings);
    if (!units.length) continue;

    const bookDir = path.join(packDir, 'content', `book${book.id}`, 'units');
    await mkdir(bookDir, { recursive: true });

    // 单元摘要（册级 book.json）与完整单元文件分开，打开课程页才读单元。
    // 摘要携带 vocab/phrases 数组（课程页筛选用）与句/题计数（列表展示用）。
    const summaries = [];
    for (const unit of units) {
      const contentId = unitContentId(book.key, unit.unit);
      const summary = {
        id: unit.id,
        contentId,
        book: unit.book,
        unit: unit.unit,
        key: unit.key,
        lessonFrom: unit.lessonFrom,
        lessonTo: unit.lessonTo,
        title: unit.title,
        titleZh: unit.titleZh,
        question: unit.question,
        vocab: unit.vocab,
        phrases: unit.phrases,
        sentenceCount: unit.sentences.length,
        exerciseCount: unit.exercises.length,
        grammarCount: unit.grammar.length,
        patternCount: unit.patterns.length,
      };
      summaries.push(summary);
      const full = { ...summary, sentences: unit.sentences, exercises: unit.exercises };
      full.vocab = unit.vocab;
      full.phrases = unit.phrases;
      full.grammar = unit.grammar;
      full.patterns = unit.patterns;
      await writeFile(
        path.join(bookDir, `u${String(unit.unit).padStart(2, '0')}.json`),
        `${JSON.stringify(full)}\n`,
        'utf8',
      );
      const searchEntry = unitSearchEntry(unit);
      searchEntry.contentId = contentId;
      searchIndex.push(searchEntry);
      unitCount.total += 1;
    }

    await writeFile(
      path.join(packDir, 'content', `book${book.id}`, 'book.json'),
      `${JSON.stringify({ id: book.id, key: book.key, units: summaries }, null, 2)}\n`,
      'utf8',
    );
    manifestBooks.push({ ...meta, entry: `content/book${book.id}/book.json` });
    console.log(
      `${book.key}: ${units.length} 单元 / ${meta.lessons} 课 / ${meta.sentences} 句 / ${meta.exercises} 题`,
    );
  }

  const manifest = {
    schemaVersion: 1,
    packId: PACK_ID,
    name: PACK_NAME,
    version: PACK_VERSION,
    minAppVersion: APP_VERSION,
    createdAt: generatedAt,
    books: manifestBooks,
    license: 'NOTICE.md',
  };
  await writeFile(path.join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(packDir, 'search-index.json'),
    `${JSON.stringify(searchIndex)}\n`,
    'utf8',
  );
  try {
    const notice = await readFile(path.join(ROOT, 'NOTICE.md'), 'utf8');
    await writeFile(path.join(packDir, 'NOTICE.md'), notice, 'utf8');
  } catch {
    warnings.push('NOTICE.md 缺失，未随包分发');
  }

  // 内置包索引：PackManager 启动时读取
  await writeFile(
    path.join(DATA_DIR, 'packs', 'bundled.json'),
    `${JSON.stringify({ version: 1, packs: [{ packId: PACK_ID, version: PACK_VERSION, base: `./data/packs/${PACK_ID}` }] }, null, 2)}\n`,
    'utf8',
  );

  // 分发 zip + 目录（检查更新用）
  const zipFiles = {};
  const collect = async (dir, prefix = '') => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await collect(full, rel);
      else {
        const buffer = await readFile(full);
        zipFiles[rel] = new Uint8Array(buffer);
      }
    }
  };
  await collect(packDir);
  const zipped = zipSync(zipFiles, { level: 6 });
  const packFile = path.join(DIST_DIR, `${PACK_ID}-${PACK_VERSION}.ncepack`);
  await writeFile(packFile, zipped);
  const sha256 = createHash('sha256').update(zipped).digest('hex');

  await writeFile(
    path.join(DATA_DIR, 'catalog.json'),
    `${JSON.stringify(
      {
        generatedAt,
        packs: [
          {
            packId: PACK_ID,
            name: PACK_NAME,
            version: PACK_VERSION,
            size: zipped.byteLength,
            sha256,
            url: `./dist/packs/${PACK_ID}-${PACK_VERSION}.ncepack`,
            minAppVersion: APP_VERSION,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const totals = {
    packs: 1,
    units: unitCount.total,
    lessons: manifestBooks.reduce((sum, book) => sum + book.lessons, 0),
    sentences: manifestBooks.reduce((sum, book) => sum + book.sentences, 0),
    exercises: manifestBooks.reduce((sum, book) => sum + book.exercises, 0),
    zipBytes: zipped.byteLength,
    sha256,
  };
  console.log('\n=== 资源包构建完成 ===');
  console.log(JSON.stringify(totals, null, 2));
  if (warnings.length) console.log(`warnings: ${warnings.length}`);
  if (errors.length) {
    console.log(`errors: ${errors.length}（前 10 条）`);
    for (const error of errors.slice(0, 10)) console.log(`  - ${error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
