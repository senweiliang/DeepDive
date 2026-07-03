#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""codemap 陈旧度报告（项目无关 · v2）

解析各单元 spec.md「落点与验证」段里 `` - `src/…` `` 形态的行 → 单元→源文件映射，
再用 git 提交时间比对：源文件最后提交是否晚于「文档最后核对时间」。核对时间优先读
spec 尾部 `<!-- verified: <commit> -->` 注释里的 commit（audit 核对无差异时只更新这一
行、不产生噪音提交）；无有效 commit 则回退文档自身最后提交时间。晚于核对时间的单元进
待核对清单，供 codemap-audit 消费。

只解析「落点与验证」段（h2，容忍 `## 10. 落点…` 编号前缀，含其下 h3 子节）内、以
`` - `<repo路径>…` `` 打头的行。兄弟扩展名简写（`` `Foo.h` · `.cpp` ``）会展开。

配置：codemap 根的 codemap.config.json 的 pathAnchorPrefixes（决定哪些前缀算源文件路径）。

用法：
    python3 docs/codemap/tools/staleness.py                # 人读报告
    python3 docs/codemap/tools/staleness.py --root docs/codemap
    python3 docs/codemap/tools/staleness.py --json         # 输出 stale.json（audit 消费）
    python3 docs/codemap/tools/staleness.py --stale-only

退出码：恒 0（报告工具，不阻断）。
"""

import argparse
import json
import os
import re
import subprocess
import sys

LANDING_START_RE = re.compile(r"^##\s+(?:\d+\.\s*)?落点")
H2_RE = re.compile(r"^##\s")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
EXT_SIBLING_RE = re.compile(r"^\.[A-Za-z0-9]+$")
VERIFIED_RE = re.compile(r"verified:\s*([0-9a-fA-F]{7,40})\b")

DEFAULT_PREFIXES = ["src", "lib", "app", "packages", "docs", "test", "tests"]
DEFAULT_SKIP = ["templates", "tools", ".git", "node_modules", ".venv"]


def codemap_root_dir():
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.basename(d) == "codemap":
            return d
        d = os.path.dirname(d)
    return os.path.dirname(os.path.abspath(__file__))


def repo_root():
    d = codemap_root_dir()
    probe = d
    while probe != os.path.dirname(probe):
        if os.path.exists(os.path.join(probe, ".git")):
            return probe
        probe = os.path.dirname(probe)
    return os.path.dirname(os.path.dirname(d))


def load_config():
    p = os.path.join(codemap_root_dir(), "codemap.config.json")
    prefixes, skip = list(DEFAULT_PREFIXES), list(DEFAULT_SKIP)
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            prefixes = cfg.get("pathAnchorPrefixes", prefixes)
            skip = cfg.get("skipDirs", skip)
        except (OSError, json.JSONDecodeError):
            pass
    return prefixes, set(skip)


PREFIXES, SKIP_DIRS = load_config()
PATH_ANCHOR_RE = re.compile(r"^(?:" + "|".join(re.escape(p) for p in PREFIXES) + r")/[\w./+\-]+$")
SRC_LINE_RE = re.compile(r"^\s*-\s+`(?:" + "|".join(re.escape(p) for p in PREFIXES) + r")/")


def find_specs(root):
    out = []
    for dirpath, dirs, files in os.walk(root):
        if os.path.basename(dirpath) in SKIP_DIRS:
            dirs[:] = []
            continue
        if "spec.md" in files:
            out.append(os.path.join(dirpath, "spec.md"))
    return sorted(out)


def parse_landing_srcs(spec_path):
    with open(spec_path, "r", encoding="utf-8") as f:
        lines = f.read().split("\n")
    out, seen, in_section, in_fence = [], set(), False, False
    for line in lines:
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if LANDING_START_RE.match(line):
            in_section = True
            continue
        if in_section and H2_RE.match(line):
            break
        if not in_section or not SRC_LINE_RE.match(line):
            continue
        prev = None
        for m in INLINE_CODE_RE.finditer(line):
            tok = m.group(1).strip()
            if PATH_ANCHOR_RE.match(tok) and not any(c in tok for c in "{}*<") and "..." not in tok:
                path = tok
            elif EXT_SIBLING_RE.match(tok) and prev:
                path = os.path.splitext(prev)[0] + tok
            else:
                continue
            prev = path
            if path not in seen:
                seen.add(path)
                out.append(path)
    return out


def read_verified_sha(spec_path):
    with open(spec_path, "r", encoding="utf-8") as f:
        for line in f:
            m = VERIFIED_RE.search(line)
            if m:
                return m.group(1)
    return None


def git_commit_time(rroot, target, is_path):
    cmd = ["git", "log", "-1", "--format=%ct\t%cI"] + (["--", target] if is_path else [target])
    try:
        r = subprocess.run(cmd, cwd=rroot, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    out = r.stdout.strip()
    if r.returncode != 0 or not out:
        return None, None
    epoch, iso = out.split("\t", 1)
    return int(epoch), iso


def build_report(root):
    rroot, croot = repo_root(), codemap_root_dir()
    report = []
    for spec in find_specs(root):
        srcs = parse_landing_srcs(spec)
        src_records, src_last = [], None
        for s in srcs:
            exists = os.path.exists(os.path.join(rroot, s))
            epoch, iso = git_commit_time(rroot, s, True) if exists else (None, None)
            rec = {"path": s, "exists": exists, "lastCommit": epoch, "lastCommitIso": iso}
            src_records.append(rec)
            if epoch is not None and (src_last is None or epoch > src_last["lastCommit"]):
                src_last = rec
        sha = read_verified_sha(spec)
        if sha:
            dct, dci = git_commit_time(rroot, sha, False)
            doc_source = "verified-commit" if dct is not None else "verified-commit-missing"
        else:
            dct, dci = git_commit_time(rroot, spec, True)
            doc_source = "doc-commit"
        if dct is None:
            doc_source, status = "uncommitted", "uncommitted"
        elif src_last is not None and src_last["lastCommit"] > dct:
            status = "stale"
        else:
            status = "fresh"
        report.append({
            "unit": os.path.relpath(os.path.dirname(spec), croot).replace("\\", "/"),
            "docPath": os.path.relpath(spec, rroot).replace("\\", "/"),
            "status": status,
            "docVerified": {"epoch": dct, "iso": dci, "source": doc_source, "sha": sha},
            "srcLastCommit": src_last,
            "srcFiles": src_records,
            "missingSrcs": [r["path"] for r in src_records if not r["exists"]],
        })
    return report


def print_human(report, stale_only):
    order = {"stale": 0, "uncommitted": 1, "fresh": 2}
    rows = sorted(report, key=lambda r: (order.get(r["status"], 9), r["unit"]))
    stale = [r for r in rows if r["status"] == "stale"]
    if stale:
        print(f"⚠️  陈旧 {len(stale)} 个单元（源码晚于文档核对时间，待 audit 核对）：")
        for r in stale:
            print(f"   {r['unit']}")
            print(f"       源最新：{r['srcLastCommit']['path']}  @ {r['srcLastCommit']['lastCommitIso']}")
            print(f"       文档核对：{r['docVerified']['iso']}（{r['docVerified']['source']}）")
    else:
        print("✅ 无陈旧单元。")
    if not stale_only:
        unc = [r for r in rows if r["status"] == "uncommitted"]
        fresh = [r for r in rows if r["status"] == "fresh"]
        if unc:
            print(f"\n·  未提交 {len(unc)} 个单元（brand-new，提交并回填 verified 后纳入追踪）。")
        if fresh:
            print(f"✅ 新鲜 {len(fresh)} 个单元。")
    miss = [r for r in rows if r["missingSrcs"]]
    if miss:
        print(f"\n⚠️  落点文件缺失 {len(miss)} 个单元（路径漂移，check.py 亦报锚点失效）：")
        for r in miss:
            print(f"   {r['unit']}：{', '.join(r['missingSrcs'])}")


def main():
    ap = argparse.ArgumentParser(description="codemap 陈旧度报告（项目无关 v2）")
    ap.add_argument("--root", default=codemap_root_dir(), help="扫描根（默认 codemap 根）")
    ap.add_argument("--json", action="store_true", help="输出 stale.json")
    ap.add_argument("--stale-only", action="store_true", help="只列 stale 单元")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    report = build_report(root)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    print(f"扫描 {os.path.relpath(root, os.getcwd()) or '.'}/：{len(report)} 个 spec.md\n")
    print_human(report, args.stale_only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
