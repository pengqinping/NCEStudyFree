#!/usr/bin/env node
/**
 * 资源包 → Framework 系列同款公众号项目（黑黄标题 + 白底正文 + 红色行内码）。
 *
 * 产出：dist/wechat-fw/book3/NN-篇名/NN-篇名.md（wechat-publish frontmatter 格式）
 * 之后编译与发布（复用 Framework 系列已实测的管线）：
 *   cd dist/wechat-fw/book3 && node <repo>/tools/build-wechat-html-nce.mjs
 *   python3 <framework项目>/tools/publish_wechat.py wechat-project --login（首次扫码）
 *   python3 <framework项目>/tools/publish_wechat.py wechat-project --all
 *
 * 用法：node tools/export-framework-style.mjs --book 3 [--out dist/wechat-fw/book3] [--covers]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKS_DIR = path.join(ROOT, 'data', 'packs');

function clean(text) {
  return String(text ?? '').replace(/<br\s*\/?>/gi, '；').replace(/\s+/g, ' ').trim();
}

function bookLabel(id) {
  return { 1: '一', 2: '二', 3: '三', 4: '四' }[id] || String(id);
}

function safeDirName(text) {
  return text.replace(/[\\/:*?"<>|，。！？、（）\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function joinMeanings(vocab) {
  return vocab.meanings
    .map((m) => `${m.pos ? `${m.pos}．` : ''}${clean(m.meaning)}`)
    .join('；');
}

function exerciseOptions(ex) {
  return (ex.options || [])
    .flatMap((o) => String(o).split(/<br\s*\/?>/i))
    .map((o) => clean(o).replace(/^[A-F][.、．]\s*/, ''))
    .filter(Boolean);
}

function renderMarkdown(unit, meta, lessonNo) {
  const lessonRange = unit.lessonFrom === unit.lessonTo ? `Lesson ${unit.lessonFrom}` : `Lesson ${unit.lessonFrom}–${unit.lessonTo}`;
  const lines = [];
  const nn = String(lessonNo).padStart(2, '0');

  lines.push(`# ${nn}｜Lesson ${lessonNo}：${unit.title}`);
  lines.push('');
  lines.push(`> 📌 **《新概念英语${bookLabel(meta.id)} · 双语精讲》系列 · 第 ${nn} 篇 / 共 60 篇**`);
  lines.push(`> 📖 ${lessonRange} · ${unit.sentences.length} 句 · ${unit.vocab.length} 词 · ${unit.grammar.length} 个语法点 · ${unit.exercises.length} 道自测题`);
  lines.push('');

  // 01 课文：粗体英文句 + 常规中文段（白底流式，空行分段）
  lines.push(`## 01 课文精读 · Text`);
  lines.push('');
  unit.sentences.forEach((s, i) => {
    lines.push(`**${i + 1}. ${s.en}**`);
    lines.push('');
    lines.push(s.zh || '（暂无译文）');
    lines.push('');
  });

  // 02 核心词汇：表格（黑底黄字表头）
  if (unit.vocab.length) {
    lines.push(`## 02 核心词汇 · Vocabulary`);
    lines.push('');
    lines.push('| 单词 | 音标 | 释义与用法 |');
    lines.push('| --- | --- | --- |');
    for (const v of unit.vocab) {
      lines.push(`| **${v.word}** | ${v.phonetic || ''} | ${joinMeanings(v)} |`);
    }
    lines.push('');
  }

  // 03 语法精讲：结构用行内码，讲解正文，例句双语
  if (unit.grammar.length) {
    lines.push(`## 03 语法精讲 · Grammar`);
    lines.push('');
    unit.grammar.forEach((g, i) => {
      lines.push(`**${i + 1}. ${clean(g.title)}**`);
      lines.push('');
      if (g.structure) {
        lines.push(`\`${clean(g.structure)}\``);
        lines.push('');
      }
      if (g.definition) {
        lines.push(clean(g.definition));
        lines.push('');
      }
      if (g.usage) {
        lines.push(clean(g.usage));
        lines.push('');
      }
      const example = (g.examples || []).find((e) => e.en);
      if (example) {
        lines.push(`**例句：${example.en}**`);
        lines.push('');
        lines.push(example.zh || '（暂无译文）');
        lines.push('');
      }
    });
  }

  // 04 句型模仿
  if (unit.patterns.length) {
    lines.push(`## 04 句型模仿 · Patterns`);
    lines.push('');
    for (const p of unit.patterns) {
      lines.push(`- **${clean(p.pattern)}**${p.explanation ? `：${clean(p.explanation)}` : ''}`);
      if (p.original) {
        lines.push(`  - 课文原句：${p.original.en}${p.original.zh ? `（${p.original.zh}）` : ''}`);
      }
      for (const ex of (p.examples || []).slice(0, 1)) {
        lines.push(`  - 仿写：${ex.en}${ex.zh ? `（${ex.zh}）` : ''}`);
      }
    }
    lines.push('');
  }

  // 05 课后自测：题干单行合并选项 + 提示括号
  if (unit.exercises.length) {
    lines.push(`## 05 课后自测 · Quiz`);
    lines.push('');
    unit.exercises.forEach((ex, i) => {
      const num = i + 1;
      const hint = ex.hint ? `（提示：${clean(ex.hint)}）` : '';
      let line = `${num}. ${clean(ex.prompt).replace(/\s*\(+\s*\)\s*$/, '（　　）')}`;
      if (ex.kind === 'choice') {
        const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
        line += `　${exerciseOptions(ex).map((opt, k) => `${keys[k]}. ${opt}`).join('　')}`;
      } else {
        line += '　答题处：____________________';
      }
      lines.push(`${line}${hint}`);
    });
    lines.push('');
    lines.push(`## 06 参考答案 · Answer Key`);
    lines.push('');
    unit.exercises.forEach((ex, i) => {
      const num = i + 1;
      let answer = '';
      if (ex.kind === 'choice') {
        const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
        const options = exerciseOptions(ex);
        answer = `${keys[ex.answer]}. ${options[ex.answer] ?? ''}`;
      } else {
        answer = clean(String(ex.answer ?? '')).replace(/^[A-F][.、．]\s*/, '');
      }
      const explain = ex.explain ? clean(ex.explain) : '';
      lines.push(`${num}. **${answer}**${explain ? `　—— ${explain.length > 90 ? `${explain.slice(0, 90)}…` : explain}` : ''}`);
    });
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('本文整理自公开学习资料，课文与译文版权归原作者及出版社所有，仅供个人学习交流。');
  lines.push('');

  // 公众号 digest：第一句课文中文
  const firstZh = unit.sentences.find((s) => s.zh)?.zh || unit.titleZh || unit.title;
  const digest = (firstZh.replace(/\s+/g, '') + `——${lessonRange}双语精讲。`).slice(0, 100);

  return {
    markdown: lines.join('\n'),
    front: {
      title: trimTitle(`新概念三 ${nn}｜Lesson ${lessonNo}：${unit.title}`, 32),
      author: 'NCE StudyFree',
      digest,
      theme: 'tech',
      source_url: 'https://cencyzp.github.io/NCEStudyFree/',
    },
    dirName: `${nn}-${safeDirName(unit.title)}`,
  };
}

function trimTitle(text, max = 32) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function main() {
  const argv = process.argv.slice(2);
  const bookId = Number(argv.includes('--book') ? argv[argv.indexOf('--book') + 1] : 3);
  const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : `dist/wechat-fw/book${bookId}`;
  const withCovers = argv.includes('--covers');
  const outDir = path.resolve(ROOT, outArg);
  await mkdir(outDir, { recursive: true });

  const bundled = JSON.parse(await readFile(path.join(PACKS_DIR, 'bundled.json'), 'utf8'));
  const pack = bundled.packs[0];
  const manifest = JSON.parse(await readFile(path.join(ROOT, pack.base, 'manifest.json'), 'utf8'));
  const meta = manifest.books.find((b) => b.id === bookId);
  if (!meta) throw new Error(`book${bookId} 不在资源包中`);
  const bookData = JSON.parse(await readFile(path.join(ROOT, pack.base, meta.entry), 'utf8'));

  let lessonNo = 0;
  for (const summary of bookData.units) {
    lessonNo += 1;
    const unitFile = `content/book${meta.id}/units/u${String(summary.unit).padStart(2, '0')}.json`;
    const unit = JSON.parse(await readFile(path.join(ROOT, pack.base, unitFile), 'utf8'));
    const { markdown, front, dirName } = renderMarkdown(unit, meta, lessonNo);
    const lessonDir = path.join(outDir, dirName);
    await mkdir(lessonDir, { recursive: true });
    const fmLines = ['---'];
    for (const [k, v] of Object.entries(front)) fmLines.push(`${k}: ${v}`);
    fmLines.push('---', '');
    await writeFile(path.join(lessonDir, `${dirName}.md`), `${fmLines.join('\n')}\n${markdown}\n`, 'utf8');
  }
  console.log(`项目已生成：${outDir}（${lessonNo} 课）`);
  console.log('下一步：');
  console.log(`  cd ${outDir} && node ${path.join(ROOT, 'tools', 'build-wechat-html-nce.mjs')}`);
  console.log(`  python3 <framework系列>/tools/publish_wechat.py wechat-project --login`);
  console.log(`  python3 <framework系列>/tools/publish_wechat.py wechat-project --all`);
  if (withCovers) console.log('（封面：见 tools/export-wechat.mjs --covers 产物，发布后人工选）');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
