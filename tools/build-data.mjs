#!/usr/bin/env node
/**
 * 将 sources/ 中的 LRC 与 notes 合并为前端可直接加载的课级数据（旧版单文件格式）。
 *
 * 注意：应用运行时已改用资源包（node tools/build-pack.mjs 产出 data/packs/），
 * 本脚本保留用于对照校验与离线降级产物。
 *
 * 输出：
 *   data/books.js          四册元数据
 *   data/book1.js ...      每册课级数据（含课文、词汇、语法、练习）
 *   data/search-index.js   轻量搜索索引
 *   docs/data-report.json  构建统计与警告
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildBookUnits, jsJson, unitSearchEntry } from './lib/units.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'sources');
const DATA_DIR = path.join(ROOT, 'data');
const DOCS_DIR = path.join(ROOT, 'docs');

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

async function readJsonFile(file) {
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

async function main() {
  const generatedAt = new Date().toISOString();
  const warnings = [];
  const errors = [];
  const booksMeta = [];
  const searchIndex = [];
  const reports = [];

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(DOCS_DIR, { recursive: true });

  for (const book of BOOKS) {
    let catalog;
    try {
      catalog = await readJsonFile(path.join(SOURCE_DIR, 'books', `${book.key}.json`));
    } catch {
      errors.push(`${book.key}: 无法读取 sources/books/${book.key}.json`);
      continue;
    }

    const { units, meta, errors: bookErrors, warnings: bookWarnings } = await buildBookUnits(
      book,
      catalog,
      async (key) => {
        try {
          return await readFile(path.join(SOURCE_DIR, 'lrc', book.key, `${key}.lrc`), 'utf8');
        } catch {
          return null;
        }
      },
      async (key) => {
        try {
          return await readJsonFile(path.join(SOURCE_DIR, 'notes', book.key, `${key}.json`));
        } catch {
          return null;
        }
      },
    );
    errors.push(...bookErrors);
    warnings.push(...bookWarnings);
    if (!units.length) continue;

    for (const unit of units) searchIndex.push(unitSearchEntry(unit));

    booksMeta.push(meta);
    reports.push(meta);

    const bookPayload = { id: book.id, key: book.key, units };
    await writeFile(
      path.join(DATA_DIR, `book${book.id}.js`),
      `window.NCE = window.NCE || {};\nwindow.NCE.booksData = window.NCE.booksData || {};\nwindow.NCE.booksData[${book.id}] = ${jsJson(bookPayload)};\n`,
      'utf8',
    );

    console.log(
      `${book.key}: ${units.length} 单元 / ${meta.lessons} 课 / ${meta.sentences} 句 / ${meta.exercises} 题`,
    );
  }

  await writeFile(
    path.join(DATA_DIR, 'books.js'),
    `window.NCE = window.NCE || {};\nwindow.NCE.books = ${jsJson(booksMeta)};\n`,
    'utf8',
  );
  await writeFile(
    path.join(DATA_DIR, 'search-index.js'),
    `window.NCE = window.NCE || {};\nwindow.NCE.searchIndex = ${jsJson(searchIndex)};\n`,
    'utf8',
  );

  const totals = {
    books: booksMeta.length,
    units: booksMeta.reduce((sum, book) => sum + book.units, 0),
    lessons: booksMeta.reduce((sum, book) => sum + book.lessons, 0),
    sentences: booksMeta.reduce((sum, book) => sum + book.sentences, 0),
    vocab: booksMeta.reduce((sum, book) => sum + book.vocab, 0),
    phrases: booksMeta.reduce((sum, book) => sum + book.phrases, 0),
    grammar: booksMeta.reduce((sum, book) => sum + book.grammar, 0),
    patterns: booksMeta.reduce((sum, book) => sum + book.patterns, 0),
    exercises: booksMeta.reduce((sum, book) => sum + book.exercises, 0),
    bilingualRatio:
      booksMeta.reduce((sum, book) => sum + book.sentences, 0) > 0
        ? booksMeta.reduce((sum, book) => sum + book.bilingualRatio * book.sentences, 0) /
          booksMeta.reduce((sum, book) => sum + book.sentences, 0)
        : 0,
  };

  const report = {
    generatedAt,
    sources: {
      lrc: 'iChochy/NCE (https://nce.mleo.site)',
      notes: 'LiDuoMiao/new-concept-english (MIT)',
    },
    totals,
    books: reports,
    warnings,
    errors,
  };
  await writeFile(
    path.join(DOCS_DIR, 'data-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(totals, null, 2));
  console.log(`warnings: ${warnings.length}, errors: ${errors.length}`);
  if (errors.length) {
    console.log('\n错误（前 20 条）：');
    for (const error of errors.slice(0, 20)) console.log(`  - ${error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
