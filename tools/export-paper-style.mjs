#!/usr/bin/env node
/**
 * 资源包 → paper-bilingual-wechat 项目（黑黄杂志风双语精读）。
 *
 * 产出 paper2wx 兼容项目目录：project.json + parts/part-NN.md + outline.md，
 * 之后的编译/封面/发布全部走该 skill 的管线：
 *   python3 <skill>/scripts/paper2wx.py build  <root>
 *   python3 <skill>/scripts/paper2wx.py lint   <root>
 *   python3 <skill>/scripts/paper2wx.py covers <root>
 *   发布见 tools/wechat-browser-publish.mjs --paper <root>
 *
 * 用法：node tools/export-paper-style.mjs --book 3 [--out dist/wechat-paper/book3]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKS_DIR = path.join(ROOT, 'data', 'packs');
const SKILL_DIR = '/Users/pengqinping/.agents/skills/paper-bilingual-wechat';

/** 上游 notes 数据里偶有字面 <br> 标签，统一清洗 */
function clean(text) {
  return String(text ?? '').replace(/<br\s*\/?>/gi, '；').replace(/\s+/g, ' ').trim();
}

function bookLabel(id) {
  return { 1: '一', 2: '二', 3: '三', 4: '四' }[id] || String(id);
}

function trim(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function joinMeanings(vocab) {
  return vocab.meanings
    .map((m) => `${m.pos ? `${m.pos}．` : ''}${clean(m.meaning)}`)
    .join('；');
}

function renderPart(unit, meta, num) {
  const lessonRange = unit.lessonFrom === unit.lessonTo ? `Lesson ${unit.lessonFrom}` : `Lesson ${unit.lessonFrom}–${unit.lessonTo}`;
  const lines = [];

  lines.push(`# ${String(unit.lessonFrom).padStart(2, '0')}｜${unit.title}`);
  lines.push('');
  lines.push(
    `%%${unit.titleZh || unit.title}：逐句双语对照 + ${unit.vocab.length} 个核心词汇 + ` +
      `${unit.grammar.length} 个语法点 + ${unit.exercises.length} 道自测题`,
  );
  lines.push('');
  lines.push(`%%${lessonRange} · 新概念英语第${bookLabel(meta.id)}册 · ${unit.sentences.length} 句`);
  lines.push('');

  // 课文：段落级英文轻卡片（每 3 句一卡）+ 卡外中文逐句白底段（Framework 观感）
  lines.push('## 01｜课文精读 · Text');
  lines.push('');
  for (let i = 0; i < unit.sentences.length; i += 3) {
    const group = unit.sentences.slice(i, i + 3);
    for (const g of group) lines.push(`> ${g.en}`);
    lines.push('');
    for (const g of group) {
      lines.push(g.zh || '（暂无译文）');
      lines.push('');
    }
  }

  // 语法：标题只留中文语法名（structure 只在 formula 块），讲解合并进 note 黄框
  if (unit.grammar.length) {
    lines.push('## 02｜语法精讲 · Grammar Notes');
    lines.push('');
    unit.grammar.forEach((g, i) => {
      const structure = clean(g.structure);
      lines.push(`### ${i + 1}．${clean(g.title)}`);
      lines.push('');
      if (structure) {
        lines.push('::: formula');
        lines.push(structure);
        lines.push(':::');
        lines.push('');
      }
      const noteBody = [clean(g.definition), clean(g.usage)].filter(Boolean).join(' ');
      if (noteBody) {
        lines.push(`::: note 讲解 · ${noteBody}`);
        lines.push(':::');
        lines.push('');
      }
      const example = (g.examples || []).find((e) => e.en);
      if (example) {
        lines.push(`> ${example.en}`);
        lines.push('');
        lines.push(example.zh || '（暂无译文）');
        lines.push('');
      }
    });
  }

  // 句型模仿
  if (unit.patterns.length) {
    lines.push('## 03｜句型模仿 · Sentence Patterns');
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

  // 练习：题干单行合并选项（避免相邻行被渲染器插字面 br）
  if (unit.exercises.length) {
    lines.push('## 04｜课后自测 · Quiz');
    lines.push('');
    lines.push(`> Quiz: try these ${unit.exercises.length} questions before checking the answer key at the end.`);
    lines.push('');
    lines.push('先自己做完这几道题，再对照文末的参考答案。');
    lines.push('');
    unit.exercises.forEach((ex, i) => {
      const num = i + 1;
      const hint = ex.hint ? `（提示：${clean(ex.hint)}）` : '';
      let line = `${num}. ${clean(ex.prompt).replace(/\s*\(+\s*\)\s*$/, '（　　）')}`;
      if (ex.kind === 'choice') {
        const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
        const options = (ex.options || [])
          .flatMap((o) => String(o).split(/<br\s*\/?>/i))
          .map((o) => clean(o).replace(/^[A-F][.、．]\s*/, ''))
          .filter(Boolean);
        line += `　${options.map((opt, k) => `${keys[k]}. ${opt}`).join('　')}`;
      } else {
        line += '　答题处：____________________';
      }
      lines.push(line + hint);
    });
    lines.push('');
    lines.push('## 05｜参考答案 · Answer Key');
    lines.push('');
    unit.exercises.forEach((ex, i) => {
      const num = i + 1;
      let answer = '';
      if (ex.kind === 'choice') {
        const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
        const options = (ex.options || [])
          .flatMap((o) => String(o).split(/<br\s*\/?>/i))
          .map((o) => clean(o).replace(/^[A-F][.、．]\s*/, ''))
          .filter(Boolean);
        answer = `${keys[ex.answer]}. ${options[ex.answer] ?? ''}`;
      } else {
        answer = clean(String(ex.answer ?? '')).replace(/^[A-F][.、．]\s*/, '');
      }
      const explain = ex.explain ? clean(ex.explain) : '';
      lines.push(`- ${num}. **${answer}**${explain ? `　—— ${explain.length > 80 ? `${explain.slice(0, 80)}…` : explain}` : ''}`);
    });
    lines.push('');
  }

  // 固定附录块 1：词汇与表达
  lines.push('## 06｜词汇与表达 · Words & Expressions');
  lines.push('');
  for (const v of unit.vocab) {
    const phonetic = v.phonetic ? ` ${v.phonetic}` : '';
    lines.push(`- **${v.word}**${phonetic} ${joinMeanings(v)}`);
  }
  lines.push('');

  // 固定附录块 2：长难句拆解（优先句型原句，不足用语法例句补齐）
  lines.push('## 07｜长难句拆解 · Sentence Clinic');
  lines.push('');
  const clinic = [];
  for (const p of unit.patterns) {
    if (p.original && clinic.length < 3) {
      clinic.push({
        en: p.original.en,
        zh: p.original.zh || '',
        note: p.explanation || clean(p.pattern),
      });
    }
  }
  for (const g of unit.grammar) {
    const example = (g.examples || []).find((e) => e.en);
    if (example && clinic.length < 3) {
      clinic.push({
        en: example.en,
        zh: example.zh || '',
        note: clean(g.usage) || clean(g.definition) || clean(g.title),
      });
    }
  }
  if (!clinic.length && unit.sentences.length) {
    const longest = [...unit.sentences].sort((a, b) => b.en.length - a.en.length)[0];
    clinic.push({ en: longest.en, zh: longest.zh || '', note: '本课最长句，朗读时注意意群停顿。' });
  }
  for (const c of clinic) {
    lines.push(`- **原句**：${c.en}`);
    lines.push(`  **结构**：${c.note}`);
    lines.push(`  **译**：${c.zh}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `*本文整理自公开学习资料，课文与译文版权归原作者及出版社所有，仅供个人学习。` +
      `配套逐句点读：NCE StudyFree（阅读原文）。*`,
  );
  lines.push('');

  return { markdown: lines.join('\n'), lessonRange, title: unit.title };
}

async function main() {
  const argv = process.argv.slice(2);
  const bookId = Number(argv.includes('--book') ? argv[argv.indexOf('--book') + 1] : 3);
  const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : `dist/wechat-paper/book${bookId}`;
  const outDir = path.resolve(ROOT, outArg);
  const partsDir = path.join(outDir, 'parts');
  await mkdir(partsDir, { recursive: true });

  const bundled = JSON.parse(await readFile(path.join(PACKS_DIR, 'bundled.json'), 'utf8'));
  const pack = bundled.packs[0];
  const manifest = JSON.parse(await readFile(path.join(ROOT, pack.base, 'manifest.json'), 'utf8'));
  const meta = manifest.books.find((b) => b.id === bookId);
  if (!meta) throw new Error(`book${bookId} 不在资源包中`);
  const bookData = JSON.parse(await readFile(path.join(ROOT, pack.base, meta.entry), 'utf8'));

  const titles = {};
  const outline = [`# 提纲｜${meta.title}（${meta.titleZh}）`, ''];
  const project = {
    title: meta.title,
    title_zh: `${meta.titleZh} · 双语精讲`,
    title_en_lines: [meta.title],
    authors: 'L.G. Alexander（课文），译文来自公开学习资料',
    source: { type: 'custom', ref: 'NCEStudyFree course pack', cite: '新概念英语课文与公开学习笔记' },
    title_prefix: `NCE${bookId}`,
    author: 'NCE StudyFree',
    titles,
    parts_total: bookData.units.length,
    target_words: 500,
  };

  for (const summary of bookData.units) {
    const unitFile = `content/book${meta.id}/units/u${String(summary.unit).padStart(2, '0')}.json`;
    const unit = JSON.parse(await readFile(path.join(ROOT, pack.base, unitFile), 'utf8'));
    const num = String(summary.lessonFrom).padStart(2, '0');
    const { markdown, lessonRange, title } = renderPart(unit, meta, num);

    // 公众号标题 ≤32 字：NCE3 01｜Lesson 1：A Puma at Large；超长去掉 Lesson 前缀
    let titleFull = `Lesson ${summary.lessonFrom}：${title}`;
    if (`NCE${bookId} ${num}｜${titleFull}`.length > 32) titleFull = title;
    titles[num] = titleFull;

    await writeFile(path.join(partsDir, `part-${num}.md`), `${markdown}\n`, 'utf8');
    outline.push(
      `- 第 ${num} 篇：${title}（${lessonRange} · ${unit.sentences.length} 句 · ${unit.vocab.length} 词 · ${unit.exercises.length} 题）`,
    );
  }

  await writeFile(path.join(outDir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'outline.md'), `${outline.join('\n')}\n`, 'utf8');
  // glossary：lint/build 不依赖，复制模板占位
  try {
    const tpl = await readFile(path.join(SKILL_DIR, 'references', 'glossary-template.md'), 'utf8');
    await writeFile(path.join(outDir, 'glossary.md'), tpl, 'utf8');
  } catch {}

  console.log(`项目已生成：${outDir}`);
  console.log(`  ${bookData.units.length} 篇 → parts/part-01.md …`);
  console.log('下一步：');
  console.log(`  python3 ${SKILL_DIR}/scripts/paper2wx.py build ${outDir}`);
  console.log(`  python3 ${SKILL_DIR}/scripts/paper2wx.py lint ${outDir}`);
  console.log(`  python3 ${SKILL_DIR}/scripts/paper2wx.py covers ${outDir}`);
  console.log(`  node tools/wechat-browser-publish.mjs --paper ${outDir} --profile ~/.cache/wechat-publish/chrome-profile-nce3`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
