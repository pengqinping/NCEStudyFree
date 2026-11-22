// 用法：node tools/build-wechat-html.mjs [NN]
// 输入：NN-篇名/NN-篇名.md（frontmatter：title/author/digest/cover）
// 输出：wechat-project/project.json + parts/part-NN.md（发布脚本用）+ wechat/part-NN.html（黑黄杂志风片段）
// 样式来自 paper-bilingual-wechat 技能（paper2wx.py build），适配本系列内容：代码块/表格/图片/列表。
// 发布：python3 tools/publish_wechat.py wechat-project --login  →  ... wechat-project --all
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, cpSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'wechat-project');
const only = process.argv[2];

// ---------- 样式常量（与 paper2wx.py 的 S 对齐） ----------
const FONT = "-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";
const S = {
  wrap: `font-family:${FONT};font-size:15px;color:#3f3f3f;line-height:1.85;letter-spacing:.3px;word-break:break-word;`,
  h2: "margin:34px 0 16px;font-size:17.5px;font-weight:700;color:#111;line-height:1.5;",
  h2_num: "background:#111;color:#fff;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px 0 0 4px;",
  h2_tit: "background:#ffd60a;color:#111;font-size:15.5px;font-weight:700;padding:3px 12px;border-radius:0 4px 4px 0;",
  h3: "margin:26px 0 12px;font-size:15.5px;color:#111;font-weight:700;",
  h3_bar: '<span style="color:#c7254e;">▎</span>',
  cn: "margin:14px 0;font-size:15px;line-height:1.85;color:#3f3f3f;text-align:justify;letter-spacing:.3px;",
  li: "margin:8px 0 8px 4px;padding-left:2px;font-size:15px;line-height:1.85;color:#3f3f3f;text-align:justify;letter-spacing:.3px;",
  li_m: "color:#111;font-weight:700;",
  note: "background:#fffdf3;border:1px dashed #e8c56b;border-radius:6px;padding:12px 14px;margin:16px 0;font-size:14px;line-height:1.8;color:#6b5726;",
  pre: "background:#f6f8fa;border-radius:6px;padding:12px 14px;margin:14px 0;border:1px solid #e1e4e8;",
  pre_label: `font-size:11px;color:#8b949e;margin-bottom:6px;font-family:${MONO};`,
  pre_line: `font-size:12.5px;line-height:1.7;color:#24292e;font-family:${MONO};white-space:pre-wrap;word-break:break-all;`,
  code_inline: `background:#f2f4f7;color:#c7254e;border-radius:3px;padding:2px 5px;font-family:${MONO};font-size:14px;word-break:break-all;`,
  img: "max-width:100%;border-radius:6px;margin:6px 0;display:block;",
  img_cap: "font-size:12px;color:#8b949e;text-align:center;margin:0 0 14px;",
  table: "border-collapse:collapse;width:100%;margin:14px 0;font-size:13px;line-height:1.7;color:#3f3f3f;",
  th: "background:#111;color:#ffd60a;padding:7px 9px;border:1px solid #111;text-align:left;font-weight:700;",
  td: "padding:7px 9px;border:1px solid #e1e4e8;vertical-align:top;",
  hr: "border:none;border-top:1px dashed #d0d7de;margin:26px 0;",
  footer: "margin:40px 0 0;padding-top:16px;border-top:1px dashed #d0d7de;font-size:13px;line-height:1.8;color:#9ca3af;",
  footer_b: "color:#111;",
};

// ---------- 行内标记（对齐 paper2wx 的 inline） ----------
function inline(text) {
  let codes = [];
  let t = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  t = t.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\x00${codes.length - 1}\x00`; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#111;">$1</strong>');
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#1a73e8;text-decoration:none;">$1</a>');
  t = t.replace(/\x00(\d+)\x00/g, (m, i) => `<code style="${S.code_inline}">${codes[+i]}</code>`);
  return t;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: m ? text.slice(m[0].length) : text };
}

function b64img(dir, rel) {
  const f = path.join(ROOT, dir, rel);
  if (!existsSync(f)) throw new Error(`缺图：${f}`);
  return `data:image/png;base64,${readFileSync(f).toString('base64')}`;
}

// ---------- 块级解析 ----------
function renderBody(dir, body) {
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // 跳过正文 H1（标题由编辑器标题栏承担）
    if (/^#\s+/.test(trimmed)) { i++; continue; }

    // 分隔线
    if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) {
      out.push(`<hr style="${S.hr}"/>`); i++; continue;
    }

    // 二级标题：## 01 引子：xxx → 黑底序号块 + 黄底标题块
    if (/^##\s+/.test(trimmed)) {
      const t = trimmed.replace(/^##\s+/, '');
      const m = t.match(/^(\d{2})\s+(.*)$/);
      if (m) {
        out.push(`<h2 style="${S.h2}"><section style="display:flex;align-items:center;">` +
          `<section style="${S.h2_num}">${m[1]}</section>` +
          `<section style="${S.h2_tit}">${inline(m[2])}</section></section></h2>`);
      } else {
        out.push(`<h2 style="${S.h2}">${inline(t)}</h2>`);
      }
      i++; continue;
    }

    // 三级标题：红 ▎ 前缀
    if (/^###\s+/.test(trimmed)) {
      const t = trimmed.replace(/^###\s+/, '');
      out.push(`<h3 style="${S.h3}">${S.h3_bar}${inline(t)}</h3>`);
      i++; continue;
    }

    // 代码块：逐行 section（公众号对 <pre> 还原不稳）
    if (/^```/.test(trimmed)) {
      const lang = trimmed.replace(/^```/, '').trim();
      i++;
      const rows = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        rows.push(lines[i]); i++;
      }
      i++;
      const label = lang ? `<section style="${S.pre_label}">${lang}</section>` : '';
      const bodyHtml = rows.map(l =>
        `<section style="${S.pre_line}">${inline(l) || '&nbsp;'}</section>`).join('');
      out.push(`<section style="${S.pre}">${label}${bodyHtml}</section>`);
      continue;
    }

    // 表格
    if (/^\|/.test(trimmed)) {
      const tbl = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) { tbl.push(lines[i].trim()); i++; }
      const cells = (r) => r.split('|').slice(1, -1).map(c => c.trim());
      const header = cells(tbl[0]);
      const bodyRows = tbl.slice(1).filter(r => !/^\|[\s:|-]+\|$/.test(r)).map(cells);
      out.push(`<table style="${S.table}"><thead><tr>` +
        header.map(h => `<th style="${S.th}">${inline(h)}</th>`).join('') +
        `</tr></thead><tbody>` +
        bodyRows.map(r => `<tr>${r.map(c => `<td style="${S.td}">${inline(c)}</td>`).join('')}</tr>`).join('') +
        `</tbody></table>`);
      continue;
    }

    // 引用块 → 奶油底卡片
    if (/^>\s?/.test(trimmed)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, '')); i++;
      }
      const inner = buf.map(b => `<p style="margin:0 0 6px;">${inline(b)}</p>`).join('');
      out.push(`<section style="${S.note}">${inner}</section>`);
      continue;
    }

    // 图片
    const img = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      const src = b64img(dir, img[2]);
      out.push(`<p style="text-align:center;margin:14px 0;">` +
        `<img src="${src}" alt="${img[1]}" style="${S.img}"/>` +
        (img[1] ? `<span style="${S.img_cap}">${img[1]}</span>` : '') + `</p>`);
      i++; continue;
    }

    // 列表（有序/无序）
    if (/^([-*]|\d+\.)\s+/.test(trimmed)) {
      let n = 1;
      while (i < lines.length && /^([-*]|\d+\.)\s+/.test(lines[i].trim())) {
        const t = lines[i].trim();
        const om = t.match(/^(\d+)\.\s+(.*)$/);
        const marker = om ? `${om[1]}. ` : '• ';
        const text = om ? om[2] : t.replace(/^[-*]\s+/, '');
        out.push(`<section style="${S.li}"><span style="${S.li_m}">${marker}</span>${inline(text)}</section>`);
        n++; i++;
      }
      continue;
    }

    // 普通段落（合并连续非空行）
    const buf = [trimmed]; i++;
    while (i < lines.length && lines[i].trim() &&
      !/^(#|```|\||>|- |\d+\. |!\[|---)/.test(lines[i].trim())) {
      buf.push(lines[i].trim()); i++;
    }
    out.push(`<p style="${S.cn}">${inline(buf.join(''))}</p>`);
  }
  return out.join('\n');
}

// ---------- 主流程 ----------
const dirs = readdirSync(ROOT).filter(d => /^\d{2}-/.test(d) && existsSync(path.join(ROOT, d, `${d}.md`))).sort();
mkdirSync(path.join(OUT, 'parts'), { recursive: true });
mkdirSync(path.join(OUT, 'wechat'), { recursive: true });

const titles = {}, covers = {};
let done = 0;
for (const dir of dirs) {
  const num = dir.slice(0, 2);
  if (only && num !== only) continue;
  const mdPath = path.join(ROOT, dir, `${dir}.md`);
  const raw = readFileSync(mdPath, 'utf8');
  const { fm, body } = parseFrontmatter(raw);

  titles[num] = fm.title || '';
  covers[num] = fm.cover || '';
  const htmlBody = renderBody(dir, body);
  const footer = `<section style="${S.footer}">` +
    `<p style="margin:0 0 6px;"><strong style="${S.footer_b}">系列</strong>：《新概念英语三 · 双语精讲》共 60 篇 · 本篇为第 ${num} 篇</p>` +
    `<p style="margin:0 0 6px;"><strong style="${S.footer_b}">配套</strong>：NCE StudyFree 逐句点读与间隔复习（阅读原文）</p>` +
    `<p style="margin:0;">课文与译文版权归原作者及出版社所有，仅供个人学习交流，转载请注明来源。</p></section>`;
  const html = `<section style="${S.wrap}">\n${htmlBody}\n${footer}\n</section>\n`;

  writeFileSync(path.join(OUT, 'wechat', `part-${num}.html`), html);
  cpSync(mdPath, path.join(OUT, 'parts', `part-${num}.md`));
  console.log(`✓ part-${num}.html  「${fm.title}」`);
  done++;
}

const project = {
  name: 'nce-book3-bilingual',
  author: '彭钦平',
  exact_titles: true,
  titles, covers,
};
writeFileSync(path.join(OUT, 'project.json'), JSON.stringify(project, null, 2) + '\n');
console.log(`\n完成 ${done} 篇 → ${OUT}`);
console.log('发布：python3 tools/publish_wechat.py wechat-project --login（首次扫码）');
console.log('      python3 tools/publish_wechat.py wechat-project 00（试一篇）');
console.log('      python3 tools/publish_wechat.py wechat-project --all');
