#!/usr/bin/env python3
"""paper2wx —— 把论文做成「中英双语公众号连载」的流水线。

子命令：
    init    从 PDF / 在线网页抽取正文，切分成 N 篇，生成带英文原文的稿件骨架
    build   parts/*.md -> wechat/*.html（可直接粘贴的公众号片段）+ 预览合集 + 词汇总表
    lint    检查「英文块 ↔ 中文段」是否配对、标记是否规范、有无 LaTeX
    covers  生成 900×383 首图（封面 + 每篇一张）
    guide   生成《发布说明.md》（排期表自动填字数与阅读时长）

典型用法：
    python3 paper2wx.py init --pdf 2608.25512v1.pdf --out ~/papers/ctx-para --parts 10
    python3 paper2wx.py init --url https://arxiv.org/abs/2506.01234 --out ~/papers/xxx
    python3 paper2wx.py build  ~/papers/ctx-para
    python3 paper2wx.py lint   ~/papers/ctx-para
    python3 paper2wx.py covers ~/papers/ctx-para
    python3 paper2wx.py guide  ~/papers/ctx-para

依赖：pypdf（PDF）、requests（网页）、Pillow（封面）。缺哪个只在用到时报错。
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

# ============================================================ 样式常量
# 黑黄撞色杂志风（参考 noodle-上手实录-公众号版.html）：
# 编号二级标题 = 黑底序号块 + 黄底标题块；三级标题带红色 ▎ 前缀；
# 导读/英文原段 = 黄左边框奶油底卡片；代码块 = 浅灰逐行 section（公众号对 <pre> 还原不稳）。
FONT = "-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"
SERIF = "Georgia,'Times New Roman','Songti SC',serif"
MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace"
MATH = "'Cambria Math','STIX Two Math','Apple Symbols'"

S = {
    "wrap": f"font-family:{FONT};font-size:15px;color:#3f3f3f;line-height:1.85;letter-spacing:.3px;word-break:break-word;",
    "h1": "font-size:21px;line-height:1.5;font-weight:700;color:#111;margin:8px 0 20px;text-align:center;",
    "lead": "border-left:4px solid #ffd60a;background:#fffbe6;padding:10px 14px;margin:16px 0;border-radius:0 6px 6px 0;",
    "zh_title": "font-size:15px;color:#3f3f3f;line-height:1.85;letter-spacing:.3px;margin:0;text-align:justify;",
    "meta": "font-size:12.5px;color:#888;margin:14px 0 18px;text-align:center;line-height:1.6;",
    "h2": "margin:34px 0 16px;font-size:17.5px;font-weight:700;color:#111;line-height:1.5;",
    "h2_num": "background:#111;color:#fff;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px 0 0 4px;",
    "h2_tit": "background:#ffd60a;color:#111;font-size:15.5px;font-weight:700;padding:3px 12px;border-radius:0 4px 4px 0;",
    "h2_under": "border-bottom:3px solid #ffd60a;padding-bottom:4px;",
    "h2zh": "font-size:13px;color:#888;margin:6px 0 16px;",
    "h3": "margin:26px 0 12px;font-size:15.5px;color:#111;font-weight:700;",
    "h3zh": "font-size:13px;color:#888;font-weight:400;",
    "h3_bar": '<span style="color:#c7254e;">▎</span>',
    "en": f"border-left:3px solid #d0d7de;background:#fafbfc;border-radius:0 6px 6px 0;padding:10px 14px;margin:16px 0;font-family:{SERIF};font-size:15px;line-height:1.8;color:#111;",
    "en_p": "margin:0 0 6px;",
    "en_li": "margin:2px 0 6px 2px;padding-left:2px;",
    "cn": "margin:14px 0;font-size:15px;line-height:1.85;color:#3f3f3f;text-align:justify;letter-spacing:.3px;",
    "li": "margin:8px 0 8px 4px;padding-left:2px;font-size:15px;line-height:1.85;color:#3f3f3f;text-align:justify;letter-spacing:.3px;",
    "li_m": "color:#111;font-weight:700;",
    "note": "background:#fffdf3;border:1px dashed #e8c56b;border-radius:6px;padding:12px 14px;margin:16px 0;font-size:14px;line-height:1.8;color:#6b5726;",
    "note_t": "font-weight:700;color:#a16207;margin:0 0 6px;font-size:14px;",
    "formula": f"background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:12px 10px;margin:14px 0;text-align:center;font-family:{MATH},{SERIF};font-size:15px;color:#111;overflow-x:auto;white-space:pre-wrap;",
    "pre": "background:#f6f8fa;border-radius:6px;padding:12px 14px;margin:14px 0;border:1px solid #e1e4e8;",
    "pre_label": f"font-size:11px;color:#8b949e;margin-bottom:6px;font-family:{MONO};",
    "pre_line": f"font-size:12.5px;line-height:1.7;color:#24292e;font-family:{MONO};white-space:pre-wrap;word-break:break-all;",
    "code_inline": f"background:#f2f4f7;color:#c7254e;border-radius:3px;padding:2px 5px;font-family:{MONO};font-size:14px;word-break:break-all;",
    "footer": "margin:40px 0 0;padding-top:16px;border-top:1px dashed #d0d7de;font-size:13px;line-height:1.8;color:#9ca3af;",
    "footer_b": "color:#111;",
}


# ============================================================ Markdown → HTML
def inline(text: str) -> str:
    """极简行内标记：`code`、**粗体**、*斜体*、[文字](链接)。代码先换占位符。"""
    text = html.escape(text, quote=False)
    codes: list[str] = []

    def stash(m):
        codes.append(m.group(1))
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = re.sub(r"\*\*([^*]+)\*\*", r'<strong style="color:#111;">\1</strong>', text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2" style="color:#1a73e8;text-decoration:none;">\1</a>', text)

    def unstash(m):
        return f'<code style="{S["code_inline"]}">{codes[int(m.group(1))]}</code>'

    return re.sub(r"\x00(\d+)\x00", unstash, text)


def join_cn(lines) -> str:
    """中文折行接回：汉字之间不加空格，英文单词之间加空格。"""
    out = ""
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        if out and re.search(r"[A-Za-z0-9,.;:)\]]$", out) and re.match(r"^[A-Za-z0-9(\[]", ln):
            out += " " + ln
        else:
            out += ln
    return out


# 二级标题的编号前缀（黑底块内容），如「一、」「3.2」「【坑】」
NUM_PREFIX = re.compile(r"^(【[^】]+】|[一二三四五六七八九十百]+、|\d+(?:\.\d+)*\.?\s+)\s*")


def h2_block(title: str) -> str:
    """编号标题排成「黑底序号块 + 黄底标题块」；无编号用黄色下划线。"""
    m = NUM_PREFIX.match(title)
    if m:
        num = m.group(1).strip()
        rest = inline(title[m.end():].strip())
        return (
            f'<h2 style="margin:38px 0 6px;">'
            f'<section style="display:flex;align-items:center;">'
            f'<section style="{S["h2_num"]}">{html.escape(num)}</section>'
            f'<section style="{S["h2_tit"]}">{rest}</section>'
            f"</section></h2>"
        )
    return f'<h2 style="{S["h2"]}"><span style="{S["h2_under"]}">{inline(title)}</span></h2>'


def render_en(items) -> str:
    """items: [('p'|'li', text)] → 英文卡片。"""
    out, buf = [], []
    for kind, txt in items:
        if kind == "li":
            if buf:
                out.append("".join(f'<p style="{S["en_p"]}">{inline(b)}</p>' for b in buf))
                buf = []
            out.append(f'<p style="{S["en_li"]}"><span style="{S["li_m"]}">• </span>{inline(txt)}</p>')
        else:
            buf.append(txt)
    if buf:
        out.append("".join(f'<p style="{S["en_p"]}">{inline(b)}</p>' for b in buf))
    return f'<section style="{S["en"]}">{"".join(out)}</section>'


def parse_md(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    meta_count = 0
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        m = re.match(r"^```[\t ]*([\w+#.-]*)\s*$", stripped)
        if m:
            lang = m.group(1)
            i += 1
            code = []
            while i < n and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            i += 1
            label = f'<section style="{S["pre_label"]}">{html.escape(lang)}</section>' if lang else ""
            rows = "".join(
                f'<section style="{S["pre_line"]}">{html.escape(l) or "&nbsp;"}</section>'
                for l in code
            )
            out.append(f'<section style="{S["pre"]}">{label}{rows}</section>')
            continue

        m = re.match(r"^:::\s*(note|formula)\s*(.*)$", stripped)
        if m:
            kind, title = m.group(1), m.group(2).strip()
            i += 1
            buf = []
            while i < n and lines[i].strip() != ":::":
                buf.append(lines[i].strip())
                i += 1
            i += 1
            if kind == "formula":
                out.append(f'<section style="{S["formula"]}">{html.escape(join_cn(buf))}</section>')
            else:
                t = f'<p style="{S["note_t"]}">{inline(title)}</p>' if title else ""
                rows, cur = [], ""
                for ln in buf:
                    ln = ln.strip()
                    if not ln:
                        continue
                    if cur and not re.search(r"[。！？；：]$", cur):
                        cur = join_cn([cur, ln])
                    else:
                        if cur:
                            rows.append(cur)
                        cur = ln
                if cur:
                    rows.append(cur)
                body = "".join(f'<p style="margin:0 0 8px;">{inline(r)}</p>' for r in rows)
                out.append(f'<section style="{S["note"]}">{t}{body}</section>')
            continue

        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            title = stripped[level:].strip()
            en, _, zh = title.partition("｜")
            if level == 1:
                out.append(f'<h1 style="{S["h1"]}">{inline(title)}</h1>')
            elif level == 2:
                out.append(h2_block(en.strip() if zh else title))
                if zh:
                    out.append(f'<p style="{S["h2zh"]}">{inline(zh.strip())}</p>')
            else:
                if zh:
                    out.append(f'<h3 style="{S["h3"]}">{S["h3_bar"]}{inline(en.strip())} '
                               f'<span style="{S["h3zh"]}">{inline(zh.strip())}</span></h3>')
                else:
                    out.append(f'<h3 style="{S["h3"]}">{S["h3_bar"]}{inline(title)}</h3>')
            i += 1
            continue

        if stripped.startswith("%%"):
            txt = stripped[2:].strip()
            if meta_count == 0:          # 首行导读：黄边奶油底卡片
                out.append(f'<section style="{S["lead"]}"><p style="{S["zh_title"]}">{inline(txt)}</p></section>')
            else:                        # 元信息：居中灰字
                out.append(f'<p style="{S["meta"]}">{inline(txt)}</p>')
            meta_count += 1
            i += 1
            continue

        if stripped.startswith(">"):
            items, buf, last = [], [], None
            while i < n and lines[i].strip().startswith(">"):
                raw = lines[i].strip()[1:]
                indent = len(raw) - len(raw.lstrip(" "))
                rs = raw.strip()
                if rs.startswith("- "):
                    if buf:
                        items.append(("p", " ".join(buf)))
                        buf = []
                    items.append(["li", rs[2:].strip()])
                    last = "li"
                elif rs.startswith("* ") or re.match(r"^\d+\.\s", rs):
                    if buf:
                        items.append(("p", " ".join(buf)))
                        buf = []
                    items.append(("p", rs))
                    last = "p"
                elif rs == "":
                    if buf:
                        items.append(("p", " ".join(buf)))
                        buf = []
                    last = None
                elif indent >= 2 and last == "li":
                    items[-1][1] += " " + rs
                else:
                    buf.append(rs)
                    last = "p"
                i += 1
            if buf:                      # 收尾：把最后一段英文刷进 items
                items.append(("p", " ".join(buf)))
            items = [(k, v) for k, v in items]
            out.append(render_en(items))
            continue

        if stripped.startswith("- "):
            items = [[lines[i].strip()[2:].strip()]]
            i += 1
            while i < n:
                cur = lines[i]
                st = cur.strip()
                if st.startswith("- "):
                    items.append([st[2:].strip()])
                    i += 1
                elif st and cur[:1].isspace():
                    items[-1].append(st)
                    i += 1
                else:
                    break
            lis = "".join(
                f'<section style="{S["li"]}"><span style="{S["li_m"]}">• </span>'
                + "<br>".join(inline(seg) for seg in segs)
                + "</section>"
                for segs in items
            )
            out.append(lis)
            continue

        buf = []
        while i < n and lines[i].strip() and not re.match(r"^(#|>|:::|```|%%|- |\* )", lines[i].strip()):
            buf.append(lines[i])
            i += 1
        out.append(f'<p style="{S["cn"]}">{inline(join_cn(buf))}</p>')

    return "\n".join(out)


# ============================================================ 项目读写
def project_path(p: str | Path) -> Path:
    path = Path(p).expanduser().resolve()
    if not (path / "project.json").exists():
        sys.exit(f"{path} 不是 paper2wx 项目（缺 project.json）。先跑 init。")
    return path


def load_project(root: Path) -> dict:
    cfg = json.loads((root / "project.json").read_text(encoding="utf-8"))
    cfg.setdefault("title_prefix", "中英双语精读")
    cfg.setdefault("titles", {})
    return cfg


def save_project(root: Path, cfg: dict) -> None:
    (root / "project.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def part_files(root: Path) -> list[Path]:
    return sorted((root / "parts").glob("part-*.md"))


def citation_line(cfg: dict) -> str:
    """纯文本引用行（用于说明文档）。"""
    src = cfg.get("source", {})
    bits = [cfg.get("authors", ""), cfg.get("title", ""), src.get("cite", "")]
    return ". ".join(b.strip().rstrip(".") for b in bits if b).replace("..", ".") + "."


def footer_html(cfg: dict) -> str:
    total = cfg.get("parts_total") or len(part_files(Path(cfg["_root"])))
    src = cfg.get("source", {})
    cite = (f'{html.escape(cfg.get("authors", ""))}. '
            f'<em>{html.escape(cfg.get("title", ""))}</em>. {html.escape(src.get("cite", ""))}')
    return (
        f'<section style="{S["footer"]}">'
        f'<p style="margin:0 0 6px;"><strong style="{S["footer_b"]}">原文</strong>：{cite}</p>'
        f'<p style="margin:0 0 6px;"><strong style="{S["footer_b"]}">说明</strong>：本系列为中英对照精读，'
        f'英文原文版权归原作者所有；中文译文、导读与词汇注释仅供学习交流，'
        f'引用请以原论文为准，技术细节请回到原文核对。</p>'
        f'<p style="margin:0;">系列共 {total} 篇 · 本篇为其中一篇 · 译注由 AI 辅助完成</p>'
        f"</section>"
    )


def build_part_html(root: Path, cfg: dict, path: Path) -> str:
    body = parse_md(path.read_text(encoding="utf-8"))
    return f'<section style="{S["wrap"]}">\n{body}\n{footer_html(cfg)}\n</section>\n'


# ============================================================ build
def cmd_build(args) -> int:
    root = project_path(args.project)
    cfg = load_project(root)
    cfg["_root"] = str(root)
    out = root / "wechat"
    out.mkdir(exist_ok=True)
    files = part_files(root)
    if not files:
        sys.exit("parts/ 下没有 part-*.md")
    rows = []
    for f in files:
        frag = build_part_html(root, cfg, f)
        (out / f"{f.stem}.html").write_text(frag, encoding="utf-8")
        m = re.search(r"^#\s+(.+)$", f.read_text(encoding="utf-8"), re.M)
        rows.append((f.stem, m.group(1).strip() if m else f.stem, len(frag)))
        print(f"{f.stem}: {len(frag):,} 字符 -> wechat/{f.stem}.html")

    # 词汇总表
    vocab = collect_vocab(files)
    if vocab:
        lis = "".join(
            f'<section style="margin:8px 0;line-height:1.85;"><strong style="color:#111;">{inline(h)}</strong> '
            f'<span style="color:#3f3f3f;">{inline(c)}</span><br>'
            f'<span style="color:#8a94a6;font-size:13.5px;">{inline(e)}</span>'
            f'<span style="color:#b9c2d0;font-size:12px;"> · {stem}</span></section>'
            for h, c, e, stem in vocab
        )
        page = (f'<section style="{S["wrap"]}"><h1 style="{S["h1"]}">系列词汇总表</h1>'
                f'<p style="font-size:13.5px;color:#888;margin:6px 0 16px;text-align:center;">'
                f'各篇关键表达合并去重，可单独发一期复习贴 · 共 {len(vocab)} 条</p>'
                f'{lis}</section>')
        (out / "00-vocabulary.html").write_text(page, encoding="utf-8")
        print(f"vocabulary: {len(vocab)} 条 -> wechat/00-vocabulary.html")

    # 预览合集
    cards = []
    for stem, _t, _n in rows:
        frag = (out / f"{stem}.html").read_text(encoding="utf-8")
        cards.append('<section style="max-width:720px;margin:0 auto 60px;background:#fff;padding:32px 28px;'
                     f'border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);">{frag}</section>')
    page = ("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>{html.escape(cfg.get('title',''))} · 中英双语精读</title></head>"
            "<body style=\"margin:0;padding:28px 12px;background:#eef1f5;\">" + "\n".join(cards) + "</body></html>")
    (out / "preview.html").write_text(page, encoding="utf-8")
    print(f"preview: wechat/preview.html（{len(rows)} 篇）")
    return 0


def collect_vocab(files):
    seen, rows = set(), []
    for f in files:
        text = f.read_text(encoding="utf-8")
        m = re.search(r"^##\s*词汇与表达.*?$", text, re.M)
        if not m:
            continue
        tail = text[m.end():]
        nxt = re.search(r"^##\s", tail, re.M)
        block = tail[: nxt.start()] if nxt else tail
        for line in block.splitlines():
            line = line.strip()
            if not line.startswith("- "):
                continue
            mm = re.match(r"\*\*([^*]+)\*\*\s*([^—]*)——\s*(.*)$", line[2:].strip())
            if not mm:
                continue
            head = mm.group(1).strip()
            if head.lower() in seen:
                continue
            seen.add(head.lower())
            rows.append((head, mm.group(2).strip(), mm.group(3).strip(), f.stem))
    return rows


# ============================================================ lint
def cmd_lint(args) -> int:
    root = project_path(args.project)
    total = 0
    for f in part_files(root):
        text = f.read_text(encoding="utf-8")
        issues = lint_text(text)
        en = sum(len(re.findall(r"[A-Za-z][A-Za-z'-]*", l)) for l in text.splitlines() if l.strip().startswith(">"))
        zh = len(re.findall(r"[\u4e00-\u9fff]", text))
        print(f"{f.name}: 英文 {en} 词 / 中文 {zh} 字 / 问题 {len(issues)}")
        for it in issues:
            print("   -", it)
        total += len(issues)
    print(f"\n合计问题 {total}")
    return 0 if total == 0 else 1


def lint_text(text: str) -> list[str]:
    issues = []
    if not text.lstrip().startswith("#"):
        issues.append("首行不是 # 标题")
    if text.count("%%") < 2:
        issues.append("缺少 %% 中文标题/元信息行")
    for need in ("词汇与表达", "长难句拆解"):
        if need not in text:
            issues.append(f"缺少「{need}」附录")
    if re.search(r"\$[^$\n]{2,}\$", text):
        issues.append("疑似 LaTeX 行内公式（$…$）")
    if "\\frac" in text or "\\text{" in text:
        issues.append("含 LaTeX 命令")

    # 块级扫描：英文块后必须紧跟中文段/列表/公式/标题
    blocks, i, n = [], 0, 0
    lines = text.split("\n")
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        if s.startswith("```") or s.startswith(":::"):
            i += 1
            while i < n and not (lines[i].strip() == ":::" or lines[i].strip().startswith("```")):
                i += 1
            i += 1
            blocks.append(("fence", ""))
            continue
        if s.startswith("#"):
            blocks.append(("h", s))
            i += 1
            continue
        if s.startswith("%%"):
            blocks.append(("meta", s))
            i += 1
            continue
        if s.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip()[1:].strip())
                i += 1
            blocks.append(("en", " ".join(buf)))
            continue
        if s.startswith("- ") or s.startswith("* "):
            while i < n:
                cur = lines[i]
                st = cur.strip()
                if st.startswith("- ") or st.startswith("* "):
                    i += 1
                elif st and cur[:1].isspace():
                    i += 1
                else:
                    break
            blocks.append(("cnlist", ""))
            continue
        buf = []
        while i < n and lines[i].strip() and not re.match(r"^(#|>|:::|```|%%|- |\* )", lines[i].strip()):
            buf.append(lines[i].strip())
            i += 1
        blocks.append(("cn", " ".join(buf)))

    in_appendix = False
    for idx, (kind, val) in enumerate(blocks):
        if kind == "h" and ("词汇与表达" in val or "长难句拆解" in val):
            in_appendix = True
        if in_appendix:
            continue
        if kind == "en":
            nxt = blocks[idx + 1][0] if idx + 1 < len(blocks) else "eof"
            if nxt not in ("cn", "cnlist", "fence", "h"):
                issues.append(f"英文块后没有中文译段：{val[:50]}…")
        if kind == "cn":
            prev = blocks[idx - 1][0] if idx else "sof"
            if prev not in ("en", "cnlist", "fence", "cn"):
                issues.append(f"中文段前没有英文原段：{val[:50]}…")
    return issues


# ============================================================ covers
COVER_TEMPLATES = {
    "kicker": "{prefix} · {n} 讲",
    "en": ["A Programming Paradigm for", "Spatiotemporal Composability"],
}


def _font(path, size):
    from PIL import ImageFont
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def draw_cover(path: Path, kicker: str, en_lines: list[str], zh_lines: list[str],
               accent: str = "#5b8cff", cite: str = "") -> None:
    from PIL import Image, ImageDraw
    W, H = 900, 383
    img = Image.new("RGB", (W, H), "#0e1726")
    d = ImageDraw.Draw(img)
    for x in range(0, W, 36):
        d.line([(x, 0), (x, H)], fill="#16233a", width=1)
    for y in range(0, H, 36):
        d.line([(0, y), (W, y)], fill="#16233a", width=1)
    d.rectangle([0, 0, 6, H], fill=accent)
    for i in range(7):
        off = i * 26
        d.line([(W - 210 + off, 0), (W + 40 + off, 250)], fill="#1b2b45", width=2)
    d.rectangle([0, H - 3, W, H], fill="#16233a")

    f_kick = _font("/System/Library/Fonts/Hiragino Sans GB.ttc", 17)
    f_en = _font("/System/Library/Fonts/Supplemental/Georgia.ttf", 30)
    f_en_s = _font("/System/Library/Fonts/Supplemental/Georgia.ttf", 22)
    f_zh = _font("/System/Library/Fonts/STHeiti Medium.ttc", 21)
    f_zh_s = _font("/System/Library/Fonts/Hiragino Sans GB.ttc", 16)

    y = 46
    d.text((44, y), kicker, font=f_kick, fill="#8ba3c7")
    y += 44
    for i, line in enumerate(en_lines[:3]):
        d.text((44, y), line, font=f_en if i == 0 else f_en_s, fill="#ffffff" if i == 0 else "#c9d6e8")
        y += 40 if i == 0 else 32
    y += 14
    for i, line in enumerate(zh_lines[:3]):
        d.text((44, y), line, font=f_zh if i == 0 else f_zh_s, fill="#e8eefc" if i == 0 else "#9fb2cc")
        y += 32 if i == 0 else 26
    if cite:
        d.text((W - 176, H - 40), cite, font=_font("/System/Library/Fonts/Supplemental/Georgia.ttf", 15), fill="#5c6f8c")
    img.save(path, "PNG")


def wrap_cjk(text: str, width: int) -> list[str]:
    out, cur = [], ""
    for ch in text:
        cur += ch
        if len(cur) >= width and ch in "，。：；、）】 ":
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out[:3]


def cmd_covers(args) -> int:
    root = project_path(args.project)
    cfg = load_project(root)
    assets = root / "assets"
    assets.mkdir(exist_ok=True)
    files = part_files(root)
    prefix = cfg.get("title_prefix", "中英双语精读")
    cite = cfg.get("source", {}).get("cite", "")
    en_all = cfg.get("title_en_lines") or COVER_TEMPLATES["en"]
    draw_cover(assets / "cover-all.png", f"{prefix} · {len(files)} 讲", en_all,
               wrap_cjk(cfg.get("title_zh", cfg.get("title", "")), 16), "#5b8cff", cite)
    for f in files:
        num = f.stem.split("-")[1]
        text = f.read_text(encoding="utf-8")
        h1 = re.search(r"^#\s+(?:[0-9]+｜)?(.+)$", text, re.M)
        metas = [l.strip()[2:].strip() for l in text.splitlines() if l.strip().startswith("%%")]
        en_title = h1.group(1).strip() if h1 else num
        zh = cfg.get("titles", {}).get(num) or (metas[0] if metas else "")
        en_lines = wrap_en(en_title, 30)
        draw_cover(assets / f"cover-{num}.png", f"{'PART'} {num} · {cfg.get('title_zh','')}"[:34],
                   en_lines, wrap_cjk(zh, 16), "#5b8cff" if int(num) % 2 else "#4ec9b0", cite)
        print(f"cover-{num}.png")
    print(f"封面 -> {assets}")
    return 0


def wrap_en(text: str, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    return lines[:3]


# ============================================================ guide
def cmd_guide(args) -> int:
    root = project_path(args.project)
    cfg = load_project(root)
    files = part_files(root)
    rows, total_en, total_zh = [], 0, 0
    for f in files:
        text = f.read_text(encoding="utf-8")
        en = sum(len(re.findall(r"[A-Za-z][A-Za-z'-]*", l)) for l in text.splitlines() if l.strip().startswith(">"))
        zh = sum(len(re.findall(r"[\u4e00-\u9fff]", l)) for l in text.splitlines()
                 if l.strip() and not l.strip().startswith(("#", ">", ":::", "%%", "- ", "*", "|")))
        num = f.stem.split("-")[1]
        minutes = max(1, round(en / 180 + zh / 420))
        total_en += en
        total_zh += zh
        title = cfg.get("titles", {}).get(num, "")
        rows.append((num, title, en, zh, minutes))
    table = ["| 篇 | 建议标题 | 英文词 | 中文字 | 精读时长（估） |", "| --- | --- | --- | --- | --- |"]
    for num, title, en, zh, minutes in rows:
        table.append(f"| {num} | {title} | {en:,} | {zh:,} | 约 {minutes} 分钟 |")
    table.append(f"| — | **合计** | **{total_en:,}** | **{total_zh:,}** | 约 {round(total_en/180 + total_zh/420)} 分钟 |")

    publish_dir = Path(__file__).resolve().parent
    doc = f"""# 发布说明｜{cfg.get('title_zh', cfg.get('title',''))}

> 原文：{citation_line(cfg)}
> 共 {len(rows)} 篇，约 {total_en:,} 词英文、{total_zh:,} 字中文。

## 一、怎么发到公众号

**手动（稳）**：浏览器打开 `wechat/preview.html` 看排版 → 复制 `wechat/part-NN.html` → 粘进公众号编辑器。

**自动（推荐）**：

```bash
python3 {publish_dir / 'publish_wechat.py'} {root} --login          # 首次扫码
python3 {publish_dir / 'publish_wechat.py'} {root} --all --author 你的署名
```

脚本只保存草稿，不群发；封面在群发前于「文章设置」里选 `assets/cover-NN.png`。

## 二、排期与体量

{chr(10).join(table)}

公众号正文上限 5 万字（图片另计），单篇超长时建议在二级标题处切开。

## 三、改稿

- 改文字：编辑 `parts/part-NN.md` → `python3 {Path(__file__).name} build {root}`
- 改样式：改本脚本顶部的 `S` 字典（全部行内样式集中在那里）
- 改封面文案：改 `project.json` 的 `titles`，再 `python3 {Path(__file__).name} covers {root}`
- 改完跑 `python3 {Path(__file__).name} lint {root}`，problems 应为 0

## 四、已知取舍

1. 证明类内容只保留「证明要点」，不逐字翻译（英语学习无增益、且符号易错）。
2. 图表改为结构化文字重述（公众号无法稳定承载论文图表）。
3. 公式为 Unicode 直排，不是排版级 LaTeX（公众号环境的硬限制）。
4. 参考文献不收录，正文引用编号保留。
"""
    (root / "发布说明.md").write_text(doc, encoding="utf-8")
    print(f"发布说明.md 已生成：{len(rows)} 篇，英文 {total_en:,} 词，中文 {total_zh:,} 字")
    return 0


# ============================================================ 抽取：PDF
HEAD_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+([A-Z][A-Za-z0-9 ,\-:&']{2,70})$")
KNOWN_HEADS = ("Abstract", "Introduction", "Related Work", "Conclusion", "References",
               "Acknowledgments", "Appendix", "Discussion", "Background", "Preliminaries")


def blocks_from_pdf(path: Path) -> list[tuple[str, str, int]]:
    """返回 [(kind, text, page)]，kind ∈ {h1,h2,p,li}。"""
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    blocks: list[tuple[str, str, int]] = []
    stop = False
    for pno, page in enumerate(reader.pages, start=1):
        if stop:
            break
        try:
            raw = page.extract_text(extraction_mode="layout") or ""
        except Exception:
            raw = page.extract_text() or ""
        raw = re.sub(r"\n\s*\d+\s*$", "", raw)
        for chunk in re.split(r"\n\s*\n", raw):
            chunk = chunk.strip("\n")
            if not chunk.strip():
                continue
            lines = [l.rstrip() for l in chunk.split("\n")]
            bare = re.sub(r"\s+", " ", chunk).strip()
            # 标题优先（否则短标题会被误判成公式）
            m0 = HEAD_RE.match(bare)
            if m0 and len(bare) < 80:
                level = 1 if "." not in m0.group(1) else 2
                blocks.append((f"h{level}", f"{m0.group(1)} {m0.group(2).strip()}", pno))
                continue
            if bare in KNOWN_HEADS:
                if bare in ("References", "Bibliography"):
                    stop = True
                    break
                blocks.append(("h1", bare, pno))
                continue
            # 公式块：英文单词很少且含数学符号
            if len(re.findall(r"[A-Za-z]{3,}", chunk)) <= 6 and re.search(r"[=≔→⇀∘×∑∂ΓΣσγφλ∏⩽≥≠∈]", chunk):
                body = "\n".join(l for l in lines if l.strip())
                blocks.append(("formula", body, pno))
                continue
            joined = ""
            for l in lines:
                s = l.strip()
                if not s:
                    continue
                if joined and re.search(r"[A-Za-z]-$", joined) and re.match(r"^[a-z]", s):
                    joined = joined[:-1] + s
                else:
                    joined = (joined + " " + s).strip()
            joined = re.sub(r"\s{2,}", " ", joined)
            m = HEAD_RE.match(joined)
            if m and len(joined) < 80:
                level = 1 if "." not in m.group(1) else 2
                blocks.append((f"h{level}", f"{m.group(1)} {m.group(2).strip()}", pno))
                continue
            if joined in KNOWN_HEADS or any(joined.startswith(k + " ") for k in ("Abstract",)):
                blocks.append(("h1", joined, pno))
                continue
            if joined.startswith(("•", "-", "·")):
                blocks.append(("li", joined.lstrip("•-· ").strip(), pno))
                continue
            blocks.append(("p", joined, pno))
    return blocks


# ============================================================ 抽取：网页
class _Extractor(__import__("html.parser", fromlist=["HTMLParser"]).HTMLParser):
    """把 HTML 拆成 (heading/paragraph/list) 块；跳过导航、目录、页脚等噪声。"""

    SKIP = {"script", "style", "nav", "footer", "header", "aside", "form", "noscript", "svg", "button"}
    # 只对「容器」按 class/id 判噪声，避免把 <a class="toc-backref"> 这类行内元素整段丢掉
    NOISE_TAGS = {"div", "section", "nav", "aside", "header", "footer", "ul", "ol", "table", "figure", "form"}
    NOISE = ("toc", "contents", "sidebar", "navigation", "navbar", "menu", "breadcrumb",
             "footer", "header", "copyright", "share", "related", "comment")
    BLOCK = {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "figcaption", "td"}
    HEAD = {"h1": 1, "h2": 2, "h3": 3, "h4": 3, "h5": 3, "h6": 3}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks: list[tuple[str, str]] = []
        self.skip_stack: list[str] = []
        self.cur: str | None = None
        self.buf: list[str] = []
        self.depth = 0

    @classmethod
    def _noise(cls, tag: str, attrs) -> bool:
        if tag not in cls.NOISE_TAGS:
            return False
        for k, v in attrs:
            if k in ("class", "id") and v:
                low = v.lower()
                if any(w in low for w in cls.NOISE):
                    return True
        return False

    def handle_starttag(self, tag, attrs):
        if self.skip_stack:
            if tag in self.SKIP or self._noise(tag, attrs):
                self.skip_stack.append(tag)
            return
        if tag in self.SKIP or self._noise(tag, attrs):
            self.skip_stack.append(tag)
            return
        if tag == "br":
            if self.cur:
                self.buf.append("\n")
            return
        if tag in self.BLOCK:
            if self.cur:
                self.depth += 1
            else:
                self.cur = tag
                self.buf = []
                self.depth = 0

    def handle_endtag(self, tag):
        if self.skip_stack:
            if tag == self.skip_stack[-1]:
                self.skip_stack.pop()
            return
        if tag in self.BLOCK and self.cur:
            if self.depth:
                self.depth -= 1
                return
            text = "".join(self.buf)
            if self.cur != "pre":
                text = re.sub(r"\s+", " ", text)
            text = text.strip()
            kind_tag = self.cur
            self.cur = None
            self.buf = []
            if text:
                if kind_tag in self.HEAD:
                    self.blocks.append((f"h{self.HEAD[kind_tag]}", text))
                elif kind_tag == "li":
                    self.blocks.append(("li", text))
                else:
                    self.blocks.append(("p", text))

    def handle_data(self, data):
        if self.skip_stack or not self.cur:
            return
        self.buf.append(data)


def _download_pdf(url: str, timeout: int = 60) -> list[tuple[str, str, int]]:
    import requests
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0 paper2wx/1.0"}, timeout=timeout)
    r.raise_for_status()
    tmp = Path("/tmp") / "paper2wx_download.pdf"
    tmp.write_bytes(r.content)
    return blocks_from_pdf(tmp)


def _arxiv_id(url: str) -> str | None:
    m = re.search(r"arxiv\.org/(?:abs|pdf|html)/([0-9]{4}\.[0-9]{4,5})", url)
    return m.group(1) if m else None


def blocks_from_url(url: str, timeout: int = 40) -> tuple[list[tuple[str, str, int]], str]:
    """返回 (blocks, 最终 URL)。

    arXiv 会依次尝试 html 版 → PDF 全文；普通网页走 HTML 抽取；.pdf 直链走 PDF 通道。
    """
    import requests
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) paper2wx/1.0"}

    aid = _arxiv_id(url)
    if aid:
        try:
            r = requests.get(f"https://arxiv.org/html/{aid}", headers=headers, timeout=timeout)
            if r.ok and "pdf" not in r.headers.get("Content-Type", ""):
                p = _Extractor()
                p.feed(r.text)
                blocks = [(k, v, 1) for k, v in p.blocks if k.startswith("h") or len(v) >= 40]
                if len([b for b in blocks if b[0] == "p"]) >= 15:
                    return blocks, f"https://arxiv.org/abs/{aid}"
        except Exception:
            pass
        blocks = _download_pdf(f"https://arxiv.org/pdf/{aid}")
        return blocks, f"https://arxiv.org/abs/{aid}"

    r = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
    r.raise_for_status()
    ctype = r.headers.get("Content-Type", "")
    if "pdf" in ctype or r.content[:4] == b"%PDF":
        return _download_pdf(url), str(r.url)

    p = _Extractor()
    p.feed(r.text)
    blocks = [(k, v, 1) for k, v in p.blocks]
    blocks = [(k, v, pg) for k, v, pg in blocks if k.startswith("h") or len(v) >= 40]
    return blocks, str(r.url)


# ============================================================ init
def section_name(text: str) -> str:
    return re.sub(r"^\d+(\.\d+)*\.?\s*", "", text).strip()


def split_sections(blocks) -> list[dict]:
    """按标题切节；每节记录标题、起始块、出现页码。"""
    sections: list[dict] = []
    cur = {"title": "Abstract", "level": 1, "blocks": [], "page": blocks[0][2] if blocks else 1}
    for kind, text, page in blocks:
        if kind in ("h1", "h2"):
            if cur["blocks"]:
                sections.append(cur)
            cur = {"title": text, "level": int(kind[1]), "blocks": [], "page": page}
        else:
            cur["blocks"].append((kind, text))
    if cur["blocks"]:
        sections.append(cur)
    return sections


def plan_parts(sections, target_words: int, need: int = 0) -> list[list[dict]]:
    """把 section 贪心分组到 ~target_words 一篇，遇到超长节则按 h2 拆开。"""
    def words(sec):
        return sum(len(t.split()) for _k, t in sec["blocks"])

    flat: list[dict] = []
    for sec in sections:
        if words(sec) <= target_words * 1.6 or sec["level"] == 2:
            flat.append(sec)
            continue
        # 超长的一级节：按其中的二级标题切
        cur = {"title": sec["title"], "level": 1, "blocks": [], "page": sec["page"]}
        for kind, text in sec["blocks"]:
            if re.match(r"^\d+\.\d+\s", text) and len(text) < 80:
                if cur["blocks"]:
                    flat.append(cur)
                cur = {"title": text, "level": 2, "blocks": [], "page": sec["page"]}
            else:
                cur["blocks"].append((kind, text))
        if cur["blocks"]:
            flat.append(cur)

    total = sum(words(sec) for sec in flat)
    budget = target_words
    if need:
        budget = max(400, total // max(1, need))
    parts, cur, cur_words = [], [], 0
    for sec in flat:
        w = words(sec)
        if cur and cur_words + w > budget * 1.15:
            parts.append(cur)
            cur, cur_words = [], 0
        cur.append(sec)
        cur_words += w
    if cur:
        parts.append(cur)
    return parts


def _sorted_sections(part: list[dict]) -> list[dict]:
    def key(sec):
        m = re.match(r"^(\d+(?:\.\d+)*)", sec["title"])
        nums = [int(x) for x in m.group(1).split(".")] if m else [99]
        return (nums, sec["page"])
    return sorted(part, key=key)


def emit_part(part: list[dict], num: int, total: int, cfg: dict) -> str:
    head = _sorted_sections(part)[0]
    title = section_name(head["title"]) or f"Part {num}"
    first_page = min(sec["page"] for sec in part)
    last_page = max(sec["page"] for sec in part)
    rng = f"第 {first_page} 页" if first_page == last_page else f"第 {first_page}–{last_page} 页"
    out = [f"# {num:02d}｜{title}", "", "%%（中文标题待填，一句话导读）", "",
           f"%%Part {num}/{total} · 原论文 {part[0]['title']}（{rng}）", ""]
    for sec in _sorted_sections(part):
        out.append(f"## {sec['title']}")
        out.append("")
        i = 0
        blocks = sec["blocks"]
        while i < len(blocks):
            kind, text = blocks[i]
            if kind == "p":
                out.extend(wrap_block("> ", text))
                out.extend(["", "（中文译文）", ""])
                i += 1
            elif kind == "li":
                # 连续的列表项合并成一个英文块，后面只留一处译文占位
                while i < len(blocks) and blocks[i][0] == "li":
                    out.append(f"> - {blocks[i][1]}")
                    i += 1
                out.extend(["", "（中文译文）", ""])
            elif kind == "formula":
                out.append("::: formula")
                out.extend(text.split("\n"))
                out.extend([":::", ""])
                i += 1
            else:
                i += 1
    out.append("## 词汇与表达｜Words & Expressions")
    out.append("")
    out.append("- **（英文表达）** 中文释义 —— 例句取自本篇正文。")
    out.append("")
    out.append("## 长难句拆解｜Sentence Clinic")
    out.append("")
    out.append("- **原句**：（抄一句本篇最难的长句）")
    out.append("  **结构**：（主句 + 从句 + 分词/介词短语怎么挂）")
    out.append("  **译**：（对应的中文）")
    out.append("")
    return "\n".join(out)


def wrap_block(prefix: str, text: str, width: int = 90) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            lines.append(prefix + cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(prefix + cur)
    return lines


def cmd_init(args) -> int:
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "parts").mkdir(exist_ok=True)
    (out / "source").mkdir(exist_ok=True)

    if args.pdf:
        src_path = Path(args.pdf).expanduser()
        if not src_path.exists():
            sys.exit(f"PDF 不存在：{src_path}")
        blocks = blocks_from_pdf(src_path)
        source = {"type": "pdf", "ref": str(src_path), "cite": f"PDF：{src_path.name}"}
        title = args.title or src_path.stem
    elif args.url:
        blocks, final = blocks_from_url(args.url)
        source = {"type": "url", "ref": final, "cite": final}
        title = args.title or args.url.rstrip("/").split("/")[-1]
    else:
        sys.exit("需要 --pdf 或 --url")

    if not blocks:
        sys.exit("没抽到正文，检查来源或用 --pdf 走 PDF 通道。")

    raw = "\n".join(f"[p{pg}] {text}" for _k, text, pg in blocks)
    (out / "source" / "raw.txt").write_text(raw + "\n", encoding="utf-8")

    sections = split_sections(blocks)
    parts = plan_parts(sections, args.target_words, args.parts)

    cfg = {
        "title": title,
        "title_zh": args.title_zh or "",
        "title_en_lines": args.title_en_lines or [],
        "authors": args.authors or "",
        "source": source,
        "title_prefix": args.prefix,
        "author": "",
        "titles": {},
        "parts_total": len(parts),
        "target_words": args.target_words,
    }
    save_project(out, cfg)

    for i, part in enumerate(parts, start=1):
        (out / "parts" / f"part-{i:02d}.md").write_text(emit_part(part, i, len(parts), cfg), encoding="utf-8")

    outline = [f"# 提纲｜{title}", ""]
    for i, part in enumerate(parts, start=1):
        words = sum(len(t.split()) for sec in part for _k, t in sec["blocks"])
        pages = sorted({sec["page"] for sec in part})
        outline.append(f"- 第 {i:02d} 篇：{section_name(_sorted_sections(part)[0]['title'])}（约 {words} 词，第 {pages[0]}–{pages[-1]} 页）")
    (out / "outline.md").write_text("\n".join(outline) + "\n", encoding="utf-8")

    for ref in ("STYLE.md", "glossary-template.md"):
        src = Path(__file__).resolve().parent.parent / "references" / ref
        if src.exists():
            dst = out / ("glossary.md" if ref.startswith("glossary") else ref)
            dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

    print(f"项目已建：{out}")
    print(f"  正文块 {len(blocks)} 个 → {len(parts)} 篇骨架（parts/part-01.md …）")
    print(f"  提纲：outline.md")
    print("下一步：按 STYLE.md 填中文译文（英文块已在骨架里），再 build / lint。")
    return 0


# ============================================================ CLI
def main() -> int:
    ap = argparse.ArgumentParser(prog="paper2wx", description="论文 → 中英双语公众号连载")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="抽取正文并生成分篇骨架")
    p.add_argument("--pdf", help="本地 PDF 路径")
    p.add_argument("--url", help="在线网页 / arXiv 链接")
    p.add_argument("--out", required=True, help="项目目录")
    p.add_argument("--parts", type=int, default=0, help="目标篇数（默认按 target-words 自动分）")
    p.add_argument("--target-words", type=int, default=3000, help="每篇英文词数上限，默认 3000")
    p.add_argument("--title", help="论文标题（英文）")
    p.add_argument("--title-zh", help="论文标题（中文）")
    p.add_argument("--title-en-lines", nargs="*", help="封面英文标题分行")
    p.add_argument("--authors", help="作者，如 'A, B, C'")
    p.add_argument("--prefix", default="中英双语精读", help="公众号标题前缀")
    p.set_defaults(func=cmd_init)

    for name, fn, doc in (("build", cmd_build, "生成公众号 HTML"),
                          ("lint", cmd_lint, "结构自检"),
                          ("covers", cmd_covers, "生成封面"),
                          ("guide", cmd_guide, "生成发布说明")):
        sp = sub.add_parser(name, help=doc)
        sp.add_argument("project", help="项目目录")
        sp.set_defaults(func=fn)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
