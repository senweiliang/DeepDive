#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""codemap 自检（项目无关 · v2）

对 `docs/codemap/`（或任意放置了本脚本的 codemap 根）这棵知识库树做机检。检查项：

  error 级（挂 pre-commit / CI 阻断）：
    1. 断链 broken-link  —— md 相对链接目标在磁盘上不存在。
    2. 孤儿 orphan        —— 已升 v2 的模块内 .md 从模块 nav.md 顺链不可达。
    3. 骨架 skeleton      —— 单元目录（{area}/<x>/）必须有 nav.md。
    4. 成熟度 maturity    —— 模块 nav 清单标 ✅ ⇔ 单元存在 spec.md。
    5. 锚点-路径 anchor   —— 反引号内 `src/…`·`docs/…` 等仓库相对路径必须存在。

  warn 级（不阻断，提示）：
    6. 锚点-符号 symbol   —— 反引号内 XxxService/XxxController/… 类符号需在源码目录命中。
    7. 行数预算 budget    —— 单元 nav / attention / index / 模块 nav 的行数上限。

  工具：
    --backlinks <path>    —— 反查哪些 .md 链接到 <path>（改被依赖单元前看影响面）。
    --emit-backlinks      —— 输出全图 backlinks.json。

判据：nav.md 是每层唯一强制入口。v2 模块 = 目录下有任一 area 目录（默认 feature/ 或 design/）。
非 v2 模块（未迁移，on-touch）下的同类问题降级 warn，不为迁移而报噪。

配置：codemap 根的 codemap.config.json（可选；缺省用内置默认）。字段见 DEFAULT_CONFIG。

用法：
    python3 docs/codemap/tools/check.py                    # 全量
    python3 docs/codemap/tools/check.py --root docs/codemap/<module>
    python3 docs/codemap/tools/check.py --backlinks docs/codemap/<module>/design/<x>
    python3 docs/codemap/tools/check.py --no-symbols       # 关掉 warn 级符号检查（慢）

退出码：任何 error = 1，干净（含仅 warn）= 0。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import deque
from urllib.parse import unquote, urlsplit

LINK_RE = re.compile(r"\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)")
SKIP_SCHEMES = {"http", "https", "mailto", "tel", "ftp", "data"}
ENTRY = "nav.md"
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")

DEFAULT_CONFIG = {
    # 单元所在的分区目录名。默认 feature（业务功能）/ design（被依赖机制）。
    "areas": ["feature", "design"],
    # 源码根目录（相对仓库根），用于符号锚点 grep。
    "srcDirs": ["src"],
    # 反引号内被当作「仓库相对路径」校验存在性的前缀。
    "pathAnchorPrefixes": ["src", "lib", "app", "packages", "docs", "test", "tests"],
    # 反引号内被当作「代码符号」校验命中的 CamelCase 后缀（命中率高、误报低）。
    "symbolSuffixes": [
        "Node", "Helper", "Provider", "Manager", "Controller", "Service", "Store",
        "Model", "Factory", "Handler", "Component", "Composable", "Hook", "Util",
        "Runner", "Writer", "Parser", "Resolver", "Context", "Executor", "Task",
        "Dialog", "Widget", "Repository", "View", "Client", "Adapter", "Middleware",
        "Reducer", "Selector",
    ],
    "budgets": {"index.md": 120, "module-nav": 80, "nav.md": 30, "attention.md": 15},
    # 不下钻的目录（骨架模板 / 工具 / 依赖），其内 .md 不入导航图校验。
    "skipDirs": ["templates", "tools", ".git", "node_modules", ".venv"],
}


def codemap_root_dir():
    """从脚本位置向上找名为 codemap 的目录。"""
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.basename(d) == "codemap":
            return d
        d = os.path.dirname(d)
    return os.path.dirname(os.path.abspath(__file__))


def repo_root():
    """从 codemap 根向上找 .git 所在目录；找不到则回退「codemap 上溯两级」。"""
    d = codemap_root_dir()
    probe = d
    while probe != os.path.dirname(probe):
        if os.path.exists(os.path.join(probe, ".git")):
            return probe
        probe = os.path.dirname(probe)
    return os.path.dirname(os.path.dirname(d))


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    p = os.path.join(codemap_root_dir(), "codemap.config.json")
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                user = json.load(f)
            for k, v in user.items():
                if v is not None:
                    cfg[k] = v
        except (OSError, json.JSONDecodeError):
            pass
    return cfg


CONFIG = load_config()
AREAS = tuple(CONFIG["areas"])
SKIP_DIRS = set(CONFIG["skipDirs"])
PATH_ANCHOR_RE = re.compile(
    r"^(?:" + "|".join(re.escape(p) for p in CONFIG["pathAnchorPrefixes"]) + r")/[\w./+\-]+$"
)
SYMBOL_RE = re.compile(r"\b([A-Z][A-Za-z0-9]+(?:" + "|".join(CONFIG["symbolSuffixes"]) + r"))\b")
BUDGET = CONFIG["budgets"]
# 反引号里像「路径 / 文件名」的 token 不做符号锚点（交给路径锚点）。
FILE_LIKE_RE = re.compile(r"[/]|\.(cpp|h|hpp|cc|ts|tsx|vue|js|jsx|py|go|rs|java|kt|swift|rb|cs|json|yaml|yml|toml|cmake|md)\b")


def find_markdown_files(root):
    out = []
    for dirpath, dirs, files in os.walk(root):
        if os.path.basename(dirpath) in SKIP_DIRS:
            dirs[:] = []
            continue
        for name in files:
            if name.endswith(".md"):
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def strip_fenced(text):
    fence_re = re.compile(r"^\s*(```|~~~)")
    kept, in_fence = [], False
    for line in text.split("\n"):
        if fence_re.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            kept.append(line)
    return "\n".join(kept)


def strip_code(text):
    text = strip_fenced(text)
    text = re.sub(r"``[^`]*``", "", text)
    text = re.sub(r"`[^`]*`", "", text)
    return text


def extract_targets(md_path):
    with open(md_path, "r", encoding="utf-8") as f:
        text = strip_code(f.read())
    base = os.path.dirname(md_path)
    results = []
    for m in LINK_RE.finditer(text):
        raw = m.group(1)
        if raw.startswith("<") and raw.endswith(">"):
            raw = raw[1:-1]
        parts = urlsplit(raw)
        if parts.scheme in SKIP_SCHEMES or not parts.path:
            continue
        target = unquote(parts.path)
        results.append((raw, os.path.normpath(os.path.join(base, target))))
    return results


def extract_targets_from_line(line, base):
    results = []
    for m in LINK_RE.finditer(line):
        raw = m.group(1)
        if raw.startswith("<") and raw.endswith(">"):
            raw = raw[1:-1]
        parts = urlsplit(raw)
        if parts.scheme in SKIP_SCHEMES or not parts.path:
            continue
        results.append((raw, os.path.normpath(os.path.join(base, unquote(parts.path)))))
    return results


def dir_nav(path):
    """目录 / 无扩展名链接归一到其 nav.md（若存在），否则 README.md（兼容未迁移模块）。"""
    if os.path.isdir(path):
        nav = os.path.join(path, "nav.md")
        return nav if os.path.exists(nav) else os.path.join(path, "README.md")
    return path


def is_v2_module(module_dir):
    return any(os.path.isdir(os.path.join(module_dir, a)) for a in AREAS)


def v2_modules(codemap_root):
    out = []
    for name in sorted(os.listdir(codemap_root)):
        d = os.path.join(codemap_root, name)
        if os.path.isdir(d) and name not in SKIP_DIRS and is_v2_module(d):
            out.append(d)
    return out


def unit_dirs(module_dir):
    out = []
    for area in AREAS:
        base = os.path.join(module_dir, area)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirs, files in os.walk(base):
            if ("nav.md" in files or "README.md" in files) and \
               os.path.abspath(dirpath) != os.path.abspath(base):
                out.append(dirpath)
    return sorted(set(out))


def check_broken(md_files, root):
    broken = []
    for md in md_files:
        for raw, resolved in extract_targets(md):
            if os.path.isdir(resolved) or os.path.exists(resolved):
                continue
            broken.append((os.path.relpath(md, root), raw, os.path.relpath(resolved, root)))
    return broken


def check_orphans_for_module(module_dir, root):
    md_files = find_markdown_files(module_dir)
    md_set = {os.path.abspath(p) for p in md_files}
    adj = {p: set() for p in md_set}
    for md in md_files:
        ap = os.path.abspath(md)
        for _raw, resolved in extract_targets(md):
            tgt = os.path.abspath(dir_nav(resolved))
            if tgt in md_set and tgt != ap:
                adj[ap].add(tgt)
    entry = os.path.abspath(os.path.join(module_dir, ENTRY))
    if entry not in md_set:
        return [os.path.relpath(module_dir, root) + "/nav.md（入口缺失）"]
    seen, q = {entry}, deque([entry])
    while q:
        for nxt in adj[q.popleft()]:
            if nxt not in seen:
                seen.add(nxt)
                q.append(nxt)
    return sorted(os.path.relpath(p, root) for p in (md_set - seen))


def check_skeleton(module_dir, root):
    missing = []
    for ud in unit_dirs(module_dir):
        if not os.path.exists(os.path.join(ud, "nav.md")) and \
           not os.path.exists(os.path.join(ud, "README.md")):
            missing.append(os.path.relpath(ud, root) + "/（缺 nav.md）")
    return missing


def _status_of_unit_in_navs(unit_dir, module_dir):
    unit_abs = os.path.abspath(unit_dir)
    for dirpath, _dirs, files in os.walk(module_dir):
        for name in files:
            if name not in ("nav.md", "README.md"):
                continue
            try:
                with open(os.path.join(dirpath, name), "r", encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                continue
            for line in text.split("\n"):
                if "✅" not in line and "⏳" not in line:
                    continue
                for _raw, resolved in extract_targets_from_line(line, dirpath):
                    if os.path.abspath(dir_nav(resolved)).startswith(unit_abs + os.sep) or \
                       os.path.abspath(resolved) == unit_abs:
                        return "✅" if "✅" in line else "⏳"
    return None


def check_maturity(module_dir, root):
    problems = []
    for ud in unit_dirs(module_dir):
        status = _status_of_unit_in_navs(ud, module_dir)
        has_spec = os.path.exists(os.path.join(ud, "spec.md"))
        rel = os.path.relpath(ud, root)
        if status == "✅" and not has_spec:
            problems.append(f"{rel}：清单标 ✅ 但缺 spec.md")
        elif status == "⏳" and has_spec:
            problems.append(f"{rel}：有 spec.md 但清单仍标 ⏳（应升 ✅）[warn]")
    return problems


def load_allowlist(codemap_root):
    p = os.path.join(codemap_root, ".check-allowlist")
    out = set()
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                s = line.split("#", 1)[0].strip()
                if s:
                    out.add(s)
    return out


def check_anchors(md_files, root, do_symbols):
    rroot = repo_root()
    allow = load_allowlist(codemap_root_dir())
    path_errors, symbol_warns = [], []
    rg = shutil.which("rg")
    src_dirs = [os.path.join(rroot, s) for s in CONFIG["srcDirs"] if os.path.isdir(os.path.join(rroot, s))]
    sym_cache = {}

    def symbol_exists(sym):
        if sym in sym_cache:
            return sym_cache[sym]
        found = False
        if src_dirs:
            try:
                if rg:
                    r = subprocess.run([rg, "-l", "-F", sym, *src_dirs], capture_output=True, timeout=30)
                else:
                    r = subprocess.run(["grep", "-rlF", sym, *src_dirs], capture_output=True, timeout=60)
                found = r.returncode == 0 and bool(r.stdout.strip())
            except (subprocess.TimeoutExpired, OSError):
                found = True  # 查不动就不报，避免假阳
        else:
            found = True      # 没配 srcDirs → 不做符号校验
        sym_cache[sym] = found
        return found

    for md in md_files:
        with open(md, "r", encoding="utf-8") as f:
            text = strip_fenced(f.read())
        rel = os.path.relpath(md, root)
        seen_syms = set()
        for m in INLINE_CODE_RE.finditer(text):
            tok = m.group(1).strip()
            if PATH_ANCHOR_RE.match(tok) and not any(c in tok for c in "...<*{"):
                if not os.path.exists(os.path.join(rroot, tok)):
                    path_errors.append((rel, tok))
            if do_symbols and not FILE_LIKE_RE.search(tok):
                for sm in SYMBOL_RE.finditer(tok):
                    sym = sm.group(1)
                    if sym in seen_syms or sym.startswith("Xxx") or sym in allow:
                        continue
                    seen_syms.add(sym)
                    if not symbol_exists(sym):
                        symbol_warns.append((rel, sym))
    return path_errors, symbol_warns


def check_budget(md_files, root):
    warns = []
    for md in md_files:
        name = os.path.basename(md)
        with open(md, "r", encoding="utf-8") as f:
            n = sum(1 for _ in f)
        limit, parent = None, os.path.basename(os.path.dirname(md))
        if name == "index.md" and os.path.dirname(md) == os.path.abspath(root):
            limit = BUDGET.get("index.md")
        elif name == "nav.md":
            path = os.path.abspath(md)
            if parent in AREAS:
                limit = BUDGET.get("module-nav")
            elif any(("/" + a + "/") in path for a in AREAS):
                limit = BUDGET.get("nav.md")
            else:
                limit = BUDGET.get("module-nav")
        elif name == "attention.md":
            limit = BUDGET.get("attention.md")
        if limit and n > limit:
            warns.append((os.path.relpath(md, root), n, limit))
    return warns


def emit_backlinks(md_files, root):
    back = {}
    for md in md_files:
        src = os.path.relpath(md, root)
        for _raw, resolved in extract_targets(md):
            tgt = dir_nav(resolved)
            if os.path.exists(tgt):
                back.setdefault(os.path.relpath(tgt, root), []).append(src)
    return {k: sorted(set(v)) for k, v in sorted(back.items())}


def query_backlinks(target, md_files, root):
    tabs = os.path.abspath(dir_nav(target) if os.path.isdir(target) else target)
    hits = []
    for md in md_files:
        for raw, resolved in extract_targets(md):
            if os.path.abspath(dir_nav(resolved)) == tabs or \
               os.path.abspath(resolved) == os.path.abspath(target):
                hits.append((os.path.relpath(md, root), raw))
                break
    return hits


def main():
    ap = argparse.ArgumentParser(description="codemap 自检（项目无关 v2）")
    ap.add_argument("--root", default=codemap_root_dir(), help="codemap 根（默认自动定位）")
    ap.add_argument("--no-symbols", action="store_true", help="跳过 warn 级符号锚点检查")
    ap.add_argument("--backlinks", metavar="PATH", help="反查引用 PATH 的 .md")
    ap.add_argument("--emit-backlinks", action="store_true", help="输出全图 backlinks.json")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    md_files = find_markdown_files(root)

    if args.backlinks:
        for rel, raw in query_backlinks(args.backlinks, md_files, root):
            print(f"   {rel}  [{raw}]")
        return 0
    if args.emit_backlinks:
        print(json.dumps(emit_backlinks(md_files, root), ensure_ascii=False, indent=2))
        return 0

    print(f"扫描 {os.path.relpath(root, os.getcwd()) or '.'}/：{len(md_files)} 篇 .md\n")
    errors = warns = 0
    codemap_root = codemap_root_dir()
    v2_names = {os.path.basename(m) for m in v2_modules(codemap_root)}

    def _codemap_rel(rel):
        return os.path.relpath(os.path.normpath(os.path.join(root, rel)), codemap_root).replace("\\", "/")

    def governed(rel):
        r = _codemap_rel(rel)
        if r.startswith("..") or "/" not in r:
            return True
        return r.split("/", 1)[0] in v2_names

    def target_in_v2(tgt_rel):
        r = _codemap_rel(tgt_rel)
        if r.startswith(".."):
            return False
        if "/" not in r:
            return True
        return r.split("/", 1)[0] in v2_names

    broken = check_broken(md_files, root)
    b_err = [x for x in broken if governed(x[0]) and target_in_v2(x[2])]
    b_warn = [x for x in broken if not (governed(x[0]) and target_in_v2(x[2]))]
    if b_err:
        errors += len(b_err)
        print(f"❌ 断链 {len(b_err)} 条：")
        for md_rel, raw, tgt in b_err:
            print(f"   {md_rel}\n       [{raw}]  →  {tgt}（不存在）")
    if b_warn:
        warns += len(b_warn)
        print(f"⚠️  断链 {len(b_warn)} 条（非 v2 模块 / 外部，on-touch 时修）：")
        for md_rel, raw, tgt in b_warn:
            print(f"   {md_rel}  [{raw}] → {tgt}")
    if not broken:
        print("✅ 断链：无")

    mods = [m for m in v2_modules(codemap_root) if os.path.abspath(m).startswith(root)]
    for module_dir in mods:
        mname = os.path.basename(module_dir)
        for o in check_orphans_for_module(module_dir, root):
            errors += 1
            print(f"❌ [{mname}] 孤儿（nav 顺链不可达）：{o}")
        for s in check_skeleton(module_dir, root):
            errors += 1
            print(f"❌ [{mname}] 骨架缺失：{s}")
        for p in check_maturity(module_dir, root):
            if p.endswith("[warn]"):
                warns += 1
                print(f"⚠️  [{mname}] {p}")
            else:
                errors += 1
                print(f"❌ [{mname}] {p}")
    if mods:
        print(f"（v2 模块：{', '.join(os.path.basename(m) for m in mods)}）")

    path_errors, symbol_warns = check_anchors(md_files, root, not args.no_symbols)
    p_err = [x for x in path_errors if governed(x[0])]
    p_warn = [x for x in path_errors if not governed(x[0])]
    if p_err:
        errors += len(p_err)
        print(f"\n❌ 路径锚点失效 {len(p_err)} 条：")
        for rel, tok in p_err:
            print(f"   {rel}  `{tok}`（不存在）")
    if p_warn:
        warns += len(p_warn)
        print(f"\n⚠️  路径锚点失效 {len(p_warn)} 条（非 v2 / 外部，on-touch 时修）：")
        for rel, tok in p_warn:
            print(f"   {rel}  `{tok}`")
    if symbol_warns:
        warns += len(symbol_warns)
        print(f"\n⚠️  符号锚点未命中 {len(symbol_warns)} 条（可能改名 / 误报，可加 .check-allowlist）：")
        for rel, sym in symbol_warns:
            print(f"   {rel}  `{sym}`")

    budget = [x for x in check_budget(md_files, root) if governed(x[0])]
    if budget:
        warns += len(budget)
        print(f"\n⚠️  行数超预算 {len(budget)} 处：")
        for rel, n, limit in budget:
            print(f"   {rel}  {n} 行 > {limit}")

    print()
    if errors:
        print(f"共 {errors} 个 error、{warns} 个 warn。")
        return 1
    print(f"error 全通过；{warns} 个 warn（不阻断）。" if warns else "全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
