#!/usr/bin/env node
/**
 * 资源包 → 微信公众号双语精讲文章（Markdown + 封面）。
 *
 * 用法：
 *   node tools/export-wechat.mjs --book 3 --unit 1            # 导出一课
 *   node tools/export-wechat.mjs --book 3 --all               # 导出整册
 *   node tools/export-wechat.mjs --book 3 --unit 1 --shot     # 同时用 Chrome 截封面图
 *   --out dist/wechat                                         # 输出目录（默认 dist/wechat）
 *
 * 结构（与发布约定一致）：逐句双语对照 + 词汇表 + 短语 + 语法精讲 +
 * 句型模仿 + 课后自测（题目在前，参考答案统一放文末）。
 * 内容整理自资源包构建产物，课文与译文版权归原作者及出版社所有。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKS_DIR = path.join(ROOT, 'data', 'packs');

function parseArgs() {
  const args = { book: 3, out: 'dist/wechat', shot: false, all: false, units: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--book') args.book = Number(argv[++i]);
    else if (argv[i] === '--unit') args.units.push(Number(argv[++i]));
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--shot') args.shot = true;
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function bookLabel(id) {
  return { 1: '一', 2: '二', 3: '三', 4: '四' }[id] || String(id);
}

/** 上游 notes 数据里偶有字面 <br> 标签，统一清洗为分隔符 */
function clean(text) {
  return String(text ?? '').replace(/<br\s*\/?>/gi, '；').replace(/\s+/g, ' ').trim();
}

function trimTitle(title, max = 32) {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}

function joinMeanings(vocab) {
  return vocab.meanings
    .map((m) => `${m.pos ? `${m.pos}．` : ''}${clean(m.meaning)}${m.usage ? `（${clean(m.usage)}）` : ''}`)
    .join('；');
}

/** 上游可能把多个选项塞进一个元素（用 <br> 分隔），拆开并去掉残留的字母前缀 */
function exerciseOptions(ex) {
  return (ex.options || [])
    .flatMap((o) => String(o).split(/<br\s*\/?>/i))
    .map((o) => clean(o).replace(/^[A-F][.、．]\s*/, ''))
    .filter(Boolean);
}

function renderExercise(ex, index) {
  const num = index + 1;
  let line = `${num}. ${clean(ex.prompt).replace(/\s*\(+\s*\)\s*$/, '（　　）')}`;
  if (ex.kind === 'choice') {
    const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
    // 选项与题干同行：选项行不是合法 markdown 列表，相邻普通行会被渲染器
    // 合并并把插入的 <br/> 转义成字面文字
    line += `　${exerciseOptions(ex).map((opt, i) => `${keys[i]}. ${opt}`).join('　')}`;
  } else {
    line += '　答题处：____________________';
  }
  const lines = [line];
  if (ex.hint) {
    lines.push('');
    lines.push(`> 提示：${ex.hint}`);
  }
  return lines.join('\n');
}

function renderAnswer(ex, index) {
  const num = index + 1;
  let answer = '';
  if (ex.kind === 'choice') {
    const options = exerciseOptions(ex);
    answer = `${['A', 'B', 'C', 'D', 'E', 'F'][ex.answer]}. ${options[ex.answer] ?? ''}`;
  } else answer = clean(String(ex.answer ?? '')).replace(/^[A-F][.、．]\s*/, '');
  const cleanExplain = ex.explain ? clean(ex.explain) : '';
  return `1. **${answer}**${cleanExplain ? `　—— ${cleanExplain.length > 70 ? `${cleanExplain.slice(0, 70)}…` : cleanExplain}` : ''}`;
}

function renderMarkdown(unit, meta) {
  const lessonRange = unit.lessonFrom === unit.lessonTo ? `Lesson ${unit.lessonFrom}` : `Lesson ${unit.lessonFrom}–${unit.lessonTo}`;
  const title = trimTitle(`新概念${bookLabel(meta.id)}｜${lessonRange}：${unit.title}`);
  const digest = trimTitle(
    `第${bookLabel(meta.id)}册第${unit.unit}课双语精讲：${unit.sentences.length} 句逐句对照、` +
      `${unit.vocab.length} 个核心词汇、${unit.grammar.length ? `语法精讲（${unit.grammar[0]?.title || ''}）` : '无独立语法点'}、` +
      `${unit.exercises.length} 道自测题，文末附参考答案。`,
    120,
  );

  const parts = [];
  parts.push('---');
  parts.push(`title: ${title}`);
  parts.push('author: NCE StudyFree');
  parts.push(`digest: ${digest}`);
  parts.push('theme: default');
  parts.push('cover: ./cover.jpg');
  parts.push('source_url: https://cencyzp.github.io/NCEStudyFree/');
  parts.push('---');
  parts.push('');
  parts.push('> 本文整理自公开学习资料，课文与译文版权归原作者及出版社所有，仅供个人学习交流。');
  parts.push('');
  parts.push(`# ${unit.title}`);
  if (unit.titleZh) parts.push(`**${unit.titleZh}**`);
  parts.push('');
  parts.push(
    `第${bookLabel(meta.id)}册 · ${lessonRange} · ${unit.sentences.length} 句 · ` +
      `${unit.vocab.length} 词 · ${unit.grammar.length} 个语法点 · ${unit.exercises.length} 道自测题`,
  );
  parts.push('');

  if (unit.question) {
    parts.push('## 课前思考');
    parts.push(`> **${unit.question}**`);
    parts.push('');
  }

  parts.push('## 课文 · 逐句双语对照');
  unit.sentences.forEach((s, i) => {
    // 单行合并（英文粗体 + 全角空格 + 中文）：渲染器逐行解析，合并可省一半块级开销
    parts.push(`${i + 1}. **${s.en}**　${s.zh || '（暂无译文）'}`);
  });
  parts.push('');

  if (unit.vocab.length) {
    parts.push('## 核心词汇');
    parts.push('| 单词 | 音标 | 释义与用法 |');
    parts.push('| --- | --- | --- |');
    for (const v of unit.vocab) {
      const phonetic = v.phonetic || '';
      parts.push(`| **${v.word}** | ${phonetic} | ${joinMeanings(v)} |`);
    }
    parts.push('');
  }

  if (unit.phrases.length) {
    parts.push('## 重点短语');
    for (const p of unit.phrases) {
      parts.push(`- **${p.phrase}**${p.usage ? `：${clean(p.usage)}` : ''}`);
      for (const ex of (p.examples || []).slice(0, 1)) {
        parts.push(`  - ${ex.en}${ex.zh ? `（${ex.zh}）` : ''}`);
      }
    }
    parts.push('');
  }

  if (unit.grammar.length) {
    parts.push('## 语法精讲');
    unit.grammar.forEach((g, i) => {
      parts.push(`### ${i + 1}. ${clean(g.title)}`);
      if (g.structure) {
        parts.push('');
        parts.push('```');
        parts.push(clean(g.structure));
        parts.push('```');
      }
      // definition 与 usage 之间必须空行分段：渲染器会把相邻行合并并插入字面 <br/>
      if (g.definition) {
        parts.push(clean(g.definition));
        if (g.usage) parts.push('');
      }
      if (g.usage) parts.push(clean(g.usage));
      if (g.examples?.length) {
        parts.push('');
        for (const ex of g.examples.slice(0, 1)) {
          parts.push(`- ${ex.en}${ex.zh ? `\n  ${ex.zh}` : ''}`);
        }
      }
      parts.push('');
    });
  }

  if (unit.patterns.length) {
    parts.push('## 句型模仿');
    unit.patterns.forEach((p) => {
      parts.push(`- **${p.pattern}**${p.explanation ? `：${clean(p.explanation)}` : ''}`);
      if (p.original) parts.push(`  - 课文原句：${p.original.en}${p.original.zh ? `（${p.original.zh}）` : ''}`);
      for (const ex of (p.examples || []).slice(0, 1)) {
        parts.push(`  - ${ex.en}${ex.zh ? `（${ex.zh}）` : ''}`);
      }
    });
    parts.push('');
  }

  if (unit.exercises.length) {
    parts.push('## 课后自测');
    unit.exercises.forEach((ex, i) => parts.push(renderExercise(ex, i)));
    parts.push('');
    parts.push('## 参考答案');
    unit.exercises.forEach((ex, i) => parts.push(renderAnswer(ex, i)));
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('*本文由 NCE StudyFree 课程数据整理生成，配合逐句点读与间隔复习效果更佳（阅读原文）。*');
    parts.push('');
  }

  return { markdown: parts.join('\n'), title, digest };
}

function renderCoverHtml(unit, meta) {
  const lessonRange = unit.lessonFrom === unit.lessonTo ? `Lesson ${unit.lessonFrom}` : `Lesson ${unit.lessonFrom}–${unit.lessonTo}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 900px; height: 383px; overflow: hidden;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #123c27, #1e5a39 68%, #2c6e47); color: #f7f1e4;
    display: flex; align-items: center; justify-content: space-between; padding: 0 64px; position: relative; }
  .deco { position: absolute; right: -8px; bottom: -60px; font-family: Georgia, serif;
    font-size: 200px; color: rgba(247,241,228,0.07); line-height: 1; }
  .left { position: relative; }
  .tag { display: inline-block; padding: 5px 12px; border: 1px solid rgba(247,241,228,0.45);
    border-radius: 999px; font-size: 15px; letter-spacing: 0.14em; }
  .lesson { font-family: Georgia, serif; font-size: 58px; margin-top: 22px; letter-spacing: -0.01em; }
  .title-zh { font-size: 30px; margin-top: 12px; opacity: 0.92; }
  .meta { margin-top: 16px; font-size: 15px; color: #b9d7c1; }
  .badge { position: relative; text-align: center; border-left: 1px solid rgba(247,241,228,0.25); padding-left: 44px; }
  .badge .big { font-family: Georgia, serif; font-size: 44px; }
  .badge .small { font-size: 13px; color: #b9d7c1; margin-top: 6px; }
</style></head><body>
  <div class="deco">NCE</div>
  <div class="left">
    <span class="tag">新概念英语${bookLabel(meta.id)} · 双语精讲</span>
    <div class="lesson">${lessonRange}</div>
    <div class="title-zh">${unit.title}</div>
    <div class="meta">${unit.titleZh ? `${unit.titleZh} · ` : ''}${unit.sentences.length} 句 · ${unit.vocab.length} 词 · ${unit.exercises.length} 题</div>
  </div>
  <div class="badge">
    <div class="big">${unit.sentences.length}</div>
    <div class="small">逐句双语对照</div>
  </div>
</body></html>`;
}

async function main() {
  const args = parseArgs();
  const outDir = path.resolve(ROOT, args.out, `book${args.book}`);
  await mkdir(outDir, { recursive: true });

  const bundled = JSON.parse(await readFile(path.join(PACKS_DIR, 'bundled.json'), 'utf8'));
  const pack = bundled.packs[0];
  const manifest = JSON.parse(await readFile(path.join(ROOT, pack.base, 'manifest.json'), 'utf8'));
  const meta = manifest.books.find((b) => b.id === args.book);
  if (!meta) throw new Error(`book${args.book} 不在资源包中`);
  const bookData = JSON.parse(await readFile(path.join(ROOT, pack.base, meta.entry), 'utf8'));

  const targets = args.all
    ? bookData.units
    : bookData.units.filter((u) => args.units.includes(u.unit));
  if (!targets.length) throw new Error('没有匹配的单元（--unit N 或 --all）');

  for (const summary of targets) {
    const unitFile = `content/book${meta.id}/units/u${String(summary.unit).padStart(2, '0')}.json`;
    const unit = JSON.parse(await readFile(path.join(ROOT, pack.base, unitFile), 'utf8'));
    const base = `lesson-${String(unit.lessonFrom).padStart(2, '0')}`;
    const lessonDir = path.join(outDir, base);
    await mkdir(lessonDir, { recursive: true });
    const { markdown } = renderMarkdown(unit, meta);
    const mdPath = path.join(lessonDir, 'lesson.md');
    await writeFile(mdPath, `${markdown}\n`, 'utf8');
    await writeFile(path.join(lessonDir, 'cover.html'), renderCoverHtml(unit, meta), 'utf8');
    console.log(`导出：${mdPath}`);
  }

  if (args.shot) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: process.env.SMOKE_BROWSER || 'chrome', headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 383 });
    for (const summary of targets) {
      const lessonDir = path.join(outDir, `lesson-${String(summary.lessonFrom).padStart(2, '0')}`);
      const htmlPath = path.join(lessonDir, 'cover.html');
      const pngPath = path.join(lessonDir, 'cover.jpg');
      await page.goto(`file://${htmlPath}`);
      await page.waitForTimeout(120);
      // headless Chrome 偶发 captureScreenshot 协议错误，重试两次
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await page.screenshot({ path: pngPath, type: 'jpeg', quality: 92 });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await page.waitForTimeout(250);
        }
      }
      if (lastError) throw lastError;
      console.log(`封面：${pngPath}`);
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
