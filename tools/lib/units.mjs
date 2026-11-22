/**
 * 单元数据构建公共库：build-data.mjs（旧版单册 JS）与 build-pack.mjs（资源包）共用。
 * 从 tools/build-data.mjs 抽取，逻辑保持一致。
 */
import { parseLrc, cleanText } from './lrc.mjs';
import { buildExercises, optionKey } from './exercises.mjs';

export function jsJson(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function unitKey(filename) {
  const match = String(filename).match(/^(\d+)(?:&(\d+))?/);
  if (!match) throw new Error(`无法解析课号：${filename}`);
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}

export function lessonRange(key) {
  const parts = key.split('-').map(Number);
  return [parts[0], parts[1] || parts[0]];
}

export function catalogTitle(unit) {
  const raw = cleanText(unit.title || unit.filename || '');
  return (
    raw.replace(/^\d{1,3}(?:&\d{1,3})?\s*[.\-–]?\s*/, '').trim() || raw
  );
}

export function normalizeExamples(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item === 'string') return { en: cleanText(item), zh: '' };
      return {
        en: cleanText(item?.en || item?.english || ''),
        zh: cleanText(item?.zh || item?.chinese || ''),
      };
    })
    .filter((item) => item.en);
}

export function normalizeVocab(list) {
  if (!Array.isArray(list)) return [];
  const normalized = list
    .map((item) => ({
      word: cleanText(item?.word || item?.term || ''),
      phonetic: cleanText(item?.phonetic || item?.ipa || ''),
      meanings: (Array.isArray(item?.meanings) ? item.meanings : [])
        .map((meaning) => ({
          pos: cleanText(meaning?.pos || meaning?.partOfSpeech || ''),
          meaning: cleanText(meaning?.meaning || meaning?.zh || ''),
          usage: cleanText(meaning?.usage || ''),
        }))
        .filter((meaning) => meaning.meaning),
    }))
    .filter((item) => item.word && item.meanings.length);
  return uniqueBy(normalized, (item) => item.word.toLowerCase());
}

export function normalizePhrases(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      phrase: cleanText(item?.phrase || item?.text || ''),
      usage: cleanText(item?.usage || item?.explanation || ''),
      examples: normalizeExamples(item?.examples),
    }))
    .filter((item) => item.phrase);
}

export function normalizeGrammar(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      title: cleanText(item?.title || item?.name || ''),
      definition: cleanText(item?.definition || item?.explanation || ''),
      structure: cleanText(item?.structure || ''),
      usage: cleanText(item?.usage || ''),
      examples: normalizeExamples(item?.examples),
    }))
    .filter((item) => item.title || item.definition);
}

export function normalizePatterns(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item === 'string') {
        return { pattern: cleanText(item), explanation: '', original: null, examples: [] };
      }
      const original = item?.original
        ? { en: cleanText(item.original.en), zh: cleanText(item.original.zh) }
        : null;
      return {
        pattern: cleanText(item?.pattern || item?.title || item?.sentence || ''),
        explanation: cleanText(item?.explanation || item?.usage || ''),
        original: original?.en ? original : null,
        examples: normalizeExamples(item?.imitations || item?.examples),
      };
    })
    .filter((item) => item.pattern);
}

/**
 * 构建一册的全部单元与汇总统计。
 * @param {object} book BOOKS 元数据（id/key/title/...）
 * @param {{ units: Array }} catalog sources/books/NCE?.json 目录
 * @param {(key: string) => Promise<string|null>} readLrc 读取 LRC 文本
 * @param {(key: string) => Promise<object|null>} readNotes 读取 notes JSON
 * @returns {{ units: Array, meta: object, errors: string[], warnings: string[] }}
 */
export async function buildBookUnits(book, catalog, readLrc, readNotes) {
  const errors = [];
  const warnings = [];
  const catalogUnits = Array.isArray(catalog.units) ? catalog.units : [];
  if (!catalogUnits.length) {
    errors.push(`${book.key}: book.json 没有 units`);
    return { units: [], meta: null, errors, warnings };
  }

  const units = [];
  for (let index = 0; index < catalogUnits.length; index += 1) {
    const entry = catalogUnits[index];
    const key = unitKey(entry.filename);
    const [lessonFrom, lessonTo] = lessonRange(key);
    const id = `b${book.id}-u${String(index + 1).padStart(2, '0')}`;
    const fallbackTitle = catalogTitle(entry);

    const lrcText = (await readLrc(key)) ?? '';
    if (!lrcText) errors.push(`${book.key}/${key}: 缺少 LRC`);
    const notes = await readNotes(key);
    if (!notes) warnings.push(`${book.key}/${key}: 缺少 notes，词汇/语法为空`);

    const parsed = parseLrc(lrcText, {
      fallbackTitle,
      extractQuestion: book.id > 1,
    });

    const title = cleanText(parsed.title) || fallbackTitle || `Lesson ${lessonFrom}`;
    const notesQuestion =
      notes?.title && /[?？]/.test(notes.title) ? cleanText(notes.title) : '';
    const question = cleanText(parsed.question) || notesQuestion;

    const unit = {
      id,
      book: book.id,
      unit: index + 1,
      key,
      lessonFrom,
      lessonTo,
      title,
      titleZh: cleanText(parsed.titleZh),
      question,
      sentences: parsed.sentences,
      vocab: normalizeVocab(notes?.vocabulary),
      phrases: normalizePhrases(notes?.phrases),
      grammar: normalizeGrammar(notes?.grammar),
      patterns: normalizePatterns(notes?.sentencePatterns),
      exercises: [],
    };

    if (!unit.sentences.length) errors.push(`${book.key}/${key}: 课文句子为空`);
    if (!unit.title) errors.push(`${book.key}/${key}: 标题为空`);
    if (!unit.vocab.length) warnings.push(`${book.key}/${key}: 词汇为空`);
    units.push(unit);
  }

  // 同册题库池：为选择题提供干扰项
  const pools = {
    vocab: uniqueBy(
      units.flatMap((unit) => unit.vocab),
      (item) => item.word.toLowerCase(),
    ),
    grammar: uniqueBy(
      units.flatMap((unit) => unit.grammar),
      (item) => optionKey(item.title),
    ),
    sentences: uniqueBy(
      units.flatMap((unit) => unit.sentences),
      (item) => (item.zh || item.en).toLowerCase(),
    ),
  };

  for (const unit of units) {
    unit.exercises = buildExercises(unit, pools);
    if (unit.exercises.length < 4) {
      warnings.push(`${unit.id}: 练习题只有 ${unit.exercises.length} 道`);
    }
  }

  const sentenceCount = units.reduce((sum, unit) => sum + unit.sentences.length, 0);
  const bilingualCount = units.reduce(
    (sum, unit) => sum + unit.sentences.filter((sentence) => sentence.zh).length,
    0,
  );
  const lessonCount = units.reduce(
    (sum, unit) => sum + (unit.lessonTo - unit.lessonFrom + 1),
    0,
  );

  const meta = {
    id: book.id,
    key: book.key,
    title: book.title,
    titleZh: book.titleZh,
    level: book.level,
    color: book.color,
    description: book.description,
    units: units.length,
    lessons: lessonCount,
    sentences: sentenceCount,
    vocab: units.reduce((sum, unit) => sum + unit.vocab.length, 0),
    phrases: units.reduce((sum, unit) => sum + unit.phrases.length, 0),
    grammar: units.reduce((sum, unit) => sum + unit.grammar.length, 0),
    patterns: units.reduce((sum, unit) => sum + unit.patterns.length, 0),
    exercises: units.reduce((sum, unit) => sum + unit.exercises.length, 0),
    bilingualRatio: sentenceCount ? bilingualCount / sentenceCount : 0,
  };

  return { units, meta, errors, warnings };
}

/** 单元 → 搜索索引条目（两个构建产物共用）。 */
export function unitSearchEntry(unit) {
  return {
    id: unit.id,
    book: unit.book,
    unit: unit.unit,
    lessonFrom: unit.lessonFrom,
    lessonTo: unit.lessonTo,
    title: unit.title,
    titleZh: unit.titleZh,
    words: unit.vocab.map((item) => item.word),
    meanings: unit.vocab.flatMap((item) => item.meanings.map((meaning) => meaning.meaning)),
    phrases: unit.phrases.map((item) => item.phrase),
  };
}
