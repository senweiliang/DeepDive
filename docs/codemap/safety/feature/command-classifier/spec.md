# 命令安全分类 spec

HEAD 文档。对齐 Claude Code Auto mode 分类器思路：把「单条命令 + 极简环境」的开放式三分类，
改为「紧凑 transcript 投影 + 两阶段模型复核」；判定来源标签见单元 nav 闭包（`heuristic` / `heuristic-context` / `model-fast` / `model-review` / `error`）。

## 行为契约

`classify(config, command, messages)` 的判定流水线（TS 与 Rust 同构，`classifier.ts` ↔ `classifier.rs`）：

1. 剥离 `cd <path> &&|;` 前缀（Windows `cd /d <path> &&` 同理）。
2. `heuristicClassify` 静态正则快判：命中即返回，不调模型。
3. `contextualHeuristicClassify` 结合 transcript 判定「任务内资源生命周期」类命令（见不变量 4）。
4. 模型两阶段：**FAST**（`max_tokens=16`，只允许输出 `allow` / `review`，`temperature=0`、thinking disabled）
   → 仅 `allow` 直接返回；其余全部进入 **REVIEW**（`max_tokens=160`，输出 `allow|block|ask` + 理由）。
5. 任何解析失败 / API 错误 → 回落 `ask`（fail-closed，永不因故障误放行或误拦截）。

分类器输入（`buildClassifierMessage` → `buildClassifierTranscript`）：

- 只含真实 user 文本（跳过 `meta` / `error` 消息）与 assistant 工具调用；**assistant 自由文本与 tool 结果被刻意排除**（取舍见 `adr/0002`）。
- 工具调用经 `toClassifierToolInput` 投影为安全相关字段（bash→`command`、read_file→`file_path`、write_file/edit_file→`file_path: new_string`、glob/grep→`{pattern,path}`、web_search→`query`、web_fetch→`url`、agent→`subagent_type: prompt`）。
- 单条最长 `MAX_ENTRY_CONTENT_CHARS=4000`（截断加 `...[truncated]`）；总 transcript 最长 `MAX_TRANSCRIPT_CHARS=16000`，从最新尾部向前保留完整 JSONL 行。
- 待审命令以 `{"bash": "<cmd>"}` 追加在 `<transcript>` 末尾，**恰好一次**（末条 assistant 消息若含 tool_calls 则先从上下文剔除）。
- 环境行 `platform=…, shell=…, workspace=…` 注入 host 真实值（Windows 语义由 prompt 平台段说明，避免模型按 POSIX 误判）。

确定性快速路径（heuristic，TS+Rust 正则同步）：

- 临时 `set PATH=… && <tool> --help|-h|--version|-V|--doctor` 仅对**自检形态**放行；任意 PATH 前缀执行仍交模型（PATH 可劫持可执行解析）。
- `isSafeChromeForTestingLaunch`：`*.chrome-for-testing\…\chrome.exe --remote-debugging-port --user-data-dir … about:blank` 放行——「可能占住 shell」是可用性问题不是安全风险。
- `isSafeWorkspaceDelete`：`del|erase` 仅当目标为相对路径、无 `..`、无通配符 `*?`、无 `&|;<>` 时放行；绝对路径 / 越级 / 通配一律 ask。
- 权限与模式边界不变：deny>ask>allow 规则（`permissions.ts`）短路在前；classifier 只接管 auto 模式下原本为 ask 的 bash 命令。

## 用户场景

- **auto 模式自动放行**：用户在 auto 模式跑 `pnpm test`、`git status` 等，heuristic 直接 allow，零模型调用、零弹窗。
- **不稳定误判回归**（2026-08-04 会话 fcb16020）：同一 `browser-harness --doctor` 在旧单阶段模型路径上 2 block / 2 allow 漂移。
  新口径下：`set PATH=… && browser-harness --doctor` 走 heuristic allow；其余形态走两阶段。
- **任务内资源生命周期**（2026-08-04 用户补充）：临时文件「创建→使用→del」、专用 Chrome「启动→taskkill 清理」不应被当作独立危险操作。
  验收口径：有启动轨迹的 `taskkill /f /im chrome.exe …` 清理命令放行；无轨迹的同形态命令 ask（不能把任意杀浏览器进程进白名单）。
- **显式持久配置**（2026-08-04 用户原则）：`setx PATH …` 不天然 block——明确、窄范围、目标可信且符合用户意图时 allow；范围/授权不清 ask；劫持解析或破坏安全配置才 block。

## 不变量

1. TS `classifier.ts` 与 Rust `classifier.rs` 的提示词 / 正则 / 解析逻辑保持逐字同步；两前端对同一命令必须同判。
2. 分类器输入永不包含 assistant 自由文本与 tool 结果（防提示注入借道历史内容）；JSONL 转义是数据不是指令。
3. 待审命令在单次请求中恰好出现一次，且总是在 `<transcript>` 末尾。
4. FAST 阶段非 `allow`（含 `review` / 空输出 / 解析失败）必进入 REVIEW；任何错误路径回落 `ask`，永不因故障 `block` 或静默 `allow`。
5. 按进程名终止（`taskkill /im …`）无启动轨迹时必为 ask；heuristic 的放行规则必须是「明确安全形态」，不随模型抖动。

## 落点与验证

- `src/tools/classifier.ts` — TS 判定流水线（heuristic → contextual → FAST → REVIEW）与输入投影
- `deepdive-rs/crates/deepdive-core/src/tools/classifier.rs` — Rust 对等实现
- `src/components/App.tsx` — auto 模式 bash 审批处把完整 `history` 传入 `classify`
- `deepdive-rs/crates/deepdive-core/src/engine.rs` — `gate_tool_interactive` 传 `&session.history`（`recent_user` 旧接口已删）
- `src/__tests__/classifier.test.ts` — TS 72 例（含 transcript 投影 / 两阶段 mock / contextual chrome 清理）
- `deepdive-rs/crates/deepdive-core/src/tools/classifier.rs` tests — Rust 10 例
- 修改清单：改 prompt / 正则 / 解析 / 常量（`MAX_TRANSCRIPT_CHARS`、`MAX_ENTRY_CONTENT_CHARS`、stage 后缀）时 TS+Rust 双实现与 `__tests__` 三处同步
- 验证：`pnpm run typecheck` + `pnpm run test`；`cargo test -p deepdive-core`；真实 API 冒烟 = 临时脚本 `scripts/zz-classifier-smoke.ts`（不提交，2026-08-04 实测 8 例两阶段全通：heuristic/contextual 4 例 allow、`terraform plan`→allow、`kubectl delete pod`→ask、`curl | bash`→block、`del C:\Users\...` 绝对路径→block）

<!-- verified: -->
