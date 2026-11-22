#!/usr/bin/env node
/**
 * NCE 双语精讲 → 公众号草稿箱（浏览器路径，独立实例）。
 *
 * 与共享技能 wechat-publish 的关系：复用其 lib（登录/填标题/粘贴/保存），
 * 但修正了编辑器打开逻辑（新版后台 type=77 编辑器 + 新版 ProseMirror 正文区定位），
 * 并强制使用独立浏览器 profile，不影响其他正在发布的任务。
 *
 * 用法：
 *   单篇：node tools/wechat-browser-publish.mjs <lesson.md> --profile <dir>
 *   批量：node tools/wechat-browser-publish.mjs --dir dist/wechat/book3 --profile <dir> \
 *           [--delay 25] [--state <file>]
 *   诊断：--inspect-only（只开编辑器导出结构）
 *
 * 批量模式：同一浏览器实例顺序发布；每篇保存后校验正文字符数；
 * 状态写入 .publish-state.json，失败跳过继续，重跑自动断点续传。
 *
 * 红线：只点「保存为草稿」，绝不自动发布/群发；封面与群发由人工在后台完成。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadPlaywright,
  launchBrowser,
  waitForToken,
  setTitle,
  setAuthor,
  saveDraft,
  prepareBodyImages,
  inspectEditor,
  HOME,
} from '/Users/pengqinping/.agents/skills/wechat-publish/scripts/lib/browser.mjs';
import { renderMarkdown } from '/Users/pengqinping/.agents/skills/wechat-publish/scripts/lib/render.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = { md: null, dir: null, paper: null, profile: null, inspectOnly: false, delay: 25, state: null, author: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') args.profile = argv[++i];
    else if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--paper') args.paper = argv[++i];
    else if (argv[i] === '--delay') args.delay = Number(argv[++i]);
    else if (argv[i] === '--state') args.state = argv[++i];
    else if (argv[i] === '--author') args.author = argv[++i];
    else if (argv[i] === '--inspect-only') args.inspectOnly = true;
    else args.md = argv[i];
  }
  return args;
}

/** paper2wx 项目模式：标题/摘要按 publish_wechat.py 的规则拼，正文用编译好的样式化 HTML。 */
function collectPaperDocs(root, authorOverride) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  const docs = [];
  for (const f of fs.readdirSync(path.join(root, 'parts')).filter((f) => /^part-\d+\.md$/.test(f)).sort()) {
    const num = f.match(/^part-(\d+)\.md$/)[1];
    const htmlPath = path.join(root, 'wechat', `part-${num}.html`);
    if (!fs.existsSync(htmlPath)) throw new Error(`缺 ${path.relative(root, htmlPath)}，先跑 paper2wx.py build`);
    const md = fs.readFileSync(path.join(root, 'parts', f), 'utf8');
    const h1 = /^#\s+(?:\d+｜)?(.+)$/m.exec(md);
    const zh = (cfg.titles || {})[num] || h1?.[1] || num;
    const prefix = cfg.title_prefix ? `${cfg.title_prefix} ${num}｜` : `${num}｜`;
    const title = trim(`${prefix}${zh}`, 32);
    // 摘要：第一个 ≥12 汉字的正文块
    let digest = '';
    for (const block of md.split(/\n\s*\n/)) {
      const b = block.trim();
      if (!b || /^[#>::%*-]/.test(b)) continue;
      if ((b.match(/[\u4e00-\u9fff]/g) || []).length < 12) continue;
      const s = b.replace(/\s+/g, '');
      digest = s.slice(0, 100) + (s.length > 100 ? '…' : '');
      break;
    }
    docs.push({
      key: `part-${num}`,
      front: { title, author: authorOverride || cfg.author || 'NCE StudyFree', digest },
      html: fs.readFileSync(htmlPath, 'utf8'),
    });
  }
  return { docs, stateFile: path.join(root, '.publish-state.json') };
}

function trim(text, max = 32) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parseDoc(mdPath) {
  const raw = fs.readFileSync(mdPath, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) throw new Error('缺少 frontmatter');
  const front = {};
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) front[m[1]] = m[2].trim();
  }
  const baseDir = path.dirname(path.resolve(mdPath));
  const prepared = prepareBodyImages(renderMarkdown(raw.slice(match[0].length), { theme: front.theme || 'default' }), baseDir);
  return { front, html: prepared.html, baseDir };
}

function collectDocs(dir) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^lesson-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
  return entries.map((name) => ({
    key: name,
    mdPath: path.join(dir, name, 'lesson.md'),
  }));
}

async function editorReady(page) {
  try {
    return await page.evaluate(() => {
      return (
        !!document.querySelector('#title') ||
        !!document.querySelector('.ProseMirror') ||
        document.querySelectorAll('[contenteditable="true"]').length > 0
      );
    });
  } catch {
    return false;
  }
}

/** 修正版编辑器打开：新版 type=77 优先，旧版 type=10 兜底，首页点击再兜底。 */
async function openEditorFixed(context, page, token) {
  for (const type of [77, 10]) {
    const url = `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=${type}&token=${token}&lang=zh_CN`;
    console.log(`• 直连编辑器（type=${type}）…`);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < 25; i += 1) {
      if (await editorReady(page)) {
        await sleep(1500);
        console.log(`✓ 编辑器已打开（type=${type}）`);
        return page;
      }
      await sleep(1000);
    }
    console.log(`  type=${type} 未能进入编辑器`);
  }

  console.log('• 从首页「新的创作」点进去（会开新 tab）…');
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape').catch(() => {});
  for (const text of ['文章', '写文章', '图文消息']) {
    const loc = page.getByText(text, { exact: true }).first();
    if ((await loc.count()) > 0) {
      await loc.click({ timeout: 4000 }).catch(() => {});
      break;
    }
  }
  for (let i = 0; i < 30; i += 1) {
    for (const p of context.pages()) {
      if (p.url().includes('appmsg_edit') && (await editorReady(p))) {
        await sleep(1500);
        await p.bringToFront().catch(() => {});
        console.log('✓ 编辑器已打开（首页入口）');
        return p;
      }
    }
    await sleep(1000);
  }

  for (const p of context.pages()) console.log(`[tabs] ${p.url().slice(0, 120)}`);
  const probe = await page
    .evaluate(() => ({
      url: location.href.slice(0, 160),
      hasTitle: !!document.querySelector('#title'),
      prosemirror: !!document.querySelector('.ProseMirror'),
      editables: document.querySelectorAll('[contenteditable="true"]').length,
      snippet: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200),
    }))
    .catch(() => ({ error: 'evaluate failed' }));
  console.log('[diag]', JSON.stringify(probe, null, 1));
  await page.screenshot({ path: '/tmp/wx-editor-diag.png' }).catch(() => {});
  throw new Error('编辑器打不开（诊断见上方 [diag] 与 /tmp/wx-editor-diag.png）');
}

/**
 * 新版编辑器（type=77）有两个 ProseMirror：第一个是标题区，第二个是正文
 * （正文 placeholder 由伪元素渲染，无 data-placeholder 属性），正文区取 last()。
 */
async function fillBodyFixed(page, html, plainDigest) {
  const pmCount = await page.evaluate(() => document.querySelectorAll('.ProseMirror').length);
  if (pmCount < 2) throw new Error(`正文编辑区未就绪（ProseMirror 数量 ${pmCount}）`);
  const body = page.locator('.ProseMirror').last();

  await body.click({ timeout: 5000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await body.evaluate(
    (el, data) => {
      const dt = new DataTransfer();
      dt.setData('text/html', data.html);
      dt.setData('text/plain', data.plain || '');
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { html, plain: plainDigest },
  );
  await sleep(2500);

  const after = await body.evaluate((el) => el.innerText.replace(/\s+/g, '').length);
  const checks = await body.evaluate((el) => {
    const t = el.innerText;
    return {
      sentences: t.includes('课文'),
      vocab: t.includes('核心词汇'),
      answers: t.includes('参考答案'),
    };
  });
  console.log(`  正文区字符数：${after}（${JSON.stringify(checks)}）`);
  if (after < 2000) throw new Error(`正文注入失败（仅 ${after} 字符），不保存`);
  return after;
}

async function main() {
  const args = parseArgs();
  if (!args.md && !args.dir && !args.paper) throw new Error('用法：<article.md> 或 --dir <lessons 目录> 或 --paper <paper2wx 项目>');

  let docList;
  let stateFile;
  if (args.paper) {
    const paperRoot = path.resolve(args.paper);
    const collected = collectPaperDocs(paperRoot, args.author);
    docList = collected.docs;
    stateFile = args.state || collected.stateFile;
  } else {
    docList = args.dir
      ? collectDocs(path.resolve(args.dir))
      : [{ key: path.basename(path.dirname(args.md)), mdPath: args.md }];
    stateFile = args.state || (args.dir ? path.join(path.resolve(args.dir), '.publish-state.json') : null);
  }
  const state = stateFile && fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { completed: [], failed: {} };

  console.log(`待发布 ${docList.length} 篇（已完成 ${state.completed.length}，跳过）`);
  const playwright = await loadPlaywright();
  const profile = path.resolve(args.profile || path.join(process.env.HOME, '.cache', 'wechat-publish', 'chrome-profile-nce3'));
  const context = await launchBrowser(playwright, profile, { headless: false });
  const page = context.pages()[0] || (await context.newPage());

  console.log('• 打开公众号后台（已登录则直接过）…');
  const token = await waitForToken(page, 300_000);
  console.log(`✓ 已登录 token=${token}`);

  if (args.inspectOnly) {
    const editor = await openEditorFixed(context, page, token);
    console.log(await inspectEditor(editor));
    await sleep(15_000);
    await context.close();
    return;
  }

  let okCount = 0;
  const failed = [];
  for (const [index, item] of docList.entries()) {
    if (state.completed.includes(item.key)) {
      console.log(`[${index + 1}/${docList.length}] 跳过 ${item.key}（已完成）`);
      continue;
    }
    console.log(`\n===== [${index + 1}/${docList.length}] ${item.key} =====`);
    try {
      const doc = item.front ? item : parseDoc(item.mdPath);
      console.log(`• ${doc.front.title}（正文 ${doc.html.length} 字符）`);
      const editor = await openEditorFixed(context, page, token);

      const titleOk = await setTitle(editor, doc.front.title);
      console.log(titleOk ? '✓ 标题已填入' : '⚠ 标题未确认');
      if (doc.front.author) await setAuthor(editor, doc.front.author);

      const bodyChars = await fillBodyFixed(editor, doc.html, doc.front.digest || '');
      const saved = await saveDraft(editor);
      if (!saved.saved) throw new Error('保存草稿未成功');
      state.completed.push(item.key);
      if (state.failed[item.key]) delete state.failed[item.key];
      if (stateFile) fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`, 'utf8');
      okCount += 1;
      console.log(`✓ ${item.key} 已入草稿箱（累计 ${okCount}）`);
    } catch (error) {
      console.error(`✗ ${item.key} 失败：${String(error?.message || error).slice(0, 160)}`);
      failed.push({ key: item.key, error: String(error?.message || error).slice(0, 160) });
      state.failed[item.key] = String(error?.message || error).slice(0, 160);
      if (stateFile) fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`, 'utf8');
    }
    if (index < docList.length - 1) {
      console.log(`… 休眠 ${args.delay}s 防风控`);
      await sleep(args.delay * 1000);
    }
  }

  console.log(`\n===== 批量结束：成功 ${okCount}，失败 ${failed.length} =====`);
  for (const f of failed) console.log(`  ✗ ${f.key}: ${f.error}`);
  console.log('收尾提醒：全部为草稿；封面需人工在「文章设置」选择，原创声明建议不勾，群发由人工执行。');
  await context.close();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
