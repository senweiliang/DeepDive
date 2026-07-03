# PORT_SPEC.md — DeepDive GUI Frontend Port (vanilla → SolidJS + Kobalte)

This is the single authoritative specification for reimplementing the DeepDive Tauri GUI frontend in **SolidJS + Kobalte**, without reference to the original vanilla source. It is a behavioral contract: every field name, CSS class, event kind, and command signature below is exact and load-bearing.

**Source of truth (do not need to read, documented here):**
- `dist/main.js` (852 lines) — boot, event dispatch, render, modals, composer, slash.
- `dist/md.js` (196 lines) — `window.renderMarkdown`, markdown→HTML string.
- `dist/app.css` (499 lines) — all styling. **Reuse verbatim.**
- `dist/index.html` — static shell (ids/classes the JS hangs off).
- `dist/preview.html` + `src/main.rs` — bridge mock + Rust command/event contract.

**Two hard rules carried from project conventions:**
- **Block spacing lives in CSS only**, keyed off wrapper classes (`.msg`, `.tool-card`, `.compact-divider`, `.err-row`). Never use inline/`margin-top` for gaps.
- **`⎿` markers use a single trailing space** (U+23BF + one space), never two. Applies to interrupted marks, subagent steps, QA previews, tool previews.

---

## 1. Overview & Architecture

### 1.1 Two channels

The entire frontend talks to the Rust backend through exactly two bridges from `window.__TAURI__`:

```js
const { invoke } = window.__TAURI__.core;   // UI → core: fire a command, get a Promise
const { listen } = window.__TAURI__.event;  // core → UI: subscribe to events
```

- **`invoke(name, args)`** — calls a Rust `#[tauri::command]`. Returns a Promise. Most calls are **fire-and-forget**; only the loaders are awaited (`app_info`, `need_setup`, `list_sessions`, `resume_session`, `balance`, `list_models`, `get_settings`, `list_agents`, `add_dir`, `rename_session`). Errors are swallowed in try/catch.
- **`listen("agent-event", msg => handleEvent(msg.payload))`** — the **single** inbound event subscription. `msg.payload` is the engine event object `e`, dispatched on `e.kind`. Every streaming update, tool card, usage line, approval, and question arrives here.

`window.renderMarkdown(text) -> htmlString` is a third dependency (a pure function, not a channel) — see §4.

Tauri converts JS camelCase arg keys to Rust snake_case automatically. **The mock bridge (`preview.html`) reads raw JS args**, so mock keys must match what the frontend passes (e.g. `submit` reads `args.input`, `add_dir` reads `args.path`/`args.persist`, `save_settings` passes camelCase `reasoningEffort`/`responseLanguage`/`turnSummary`/`tavilyKey`).

### 1.2 Boot flow

The original sets up DOM refs and constants at module load, then runs `boot()` last. In Solid this becomes: mount the App component, run a `boot()` effect `onMount`.

```
1. applyTheme(curTheme())           // sync theme button with pre-paint <html data-theme>
2. wire model label click → openModelPicker
3. listen("agent-event", handleEvent)
4. boot():
   a. info = await invoke("app_info")            // try/catch swallow
      → store model label, contextWindow, resolve mode from MODES (fallback MODES[0])
   b. needs = await invoke("need_setup")         // default false on throw
   c. if needs === true → showSetup() and RETURN  (app is gated; nothing else loads)
   d. else → afterSetup()
afterSetup(): loadSessions(); loadBalance(); focus composer.
```

**Pre-paint theme (no-flash):** `index.html` `<head>` runs, before any framework code:
```html
<script>try { document.documentElement.setAttribute("data-theme",
  localStorage.getItem("dd-theme") || "light"); } catch (e) {}</script>
```
Keep this inline script in the Solid `index.html`. Default theme is **`"light"`**.

### 1.3 The committed/live split (most load-bearing architectural fact)

There are **two** transcript regions:

| Region | Element | Content type | Mutation | Cursor? |
|---|---|---|---|---|
| **Committed** | `#thread` | Markdown-rendered HTML | Append-only | No |
| **Live** | `#live` | Plain text (`textContent`) | Full rebuild every render | Yes (`.cursor`) |

During a turn, streaming `thinking`/`content` text shows in `#live` as **plain text**. On the `assistant` event the accumulated text is **committed** into `#thread` as **markdown** (thinking folded into a `<details>`, content into `.body`), then live is cleared. There is a momentary handoff where the same text exists first as live plain-text then as committed markdown. **Do not render markdown in the live region.**

In Solid: `#thread` = `<For>` over a `messages[]` store array; `#live` = a separate component reading `liveThinking`/`liveContent` signals.

### 1.4 Module/global state

| State | Init | Meaning |
|---|---|---|
| `modeId` | `"auto"` | current approval mode id |
| `busy` | `false` | a turn is running |
| `hasContent` | `false` | any transcript content appeared (controls greeting) |
| `liveThinking` | `""` | live uncommitted thinking text |
| `liveContent` | `""` | live uncommitted assistant/bash text |
| `ctxWindow` | `0` | context window size (from `app_info`) |
| `toolCards` | `Map<callId, el>` | tool-card lookup |
| `cmdHistory` | `[]` | submitted-input recall history |
| `histIdx` | `-1` | recall index (-1 = not recalling) |
| `histDraft` | `""` | stashed live draft while recalling |
| `qState` | `null` | active question modal state |
| `slashItems` | `[]` | filtered slash items shown |
| `slashSel` | `0` | highlighted slash index |

See §7 for the recommended Solid store shape.

### 1.5 Static constants

- **`MODES`** (5): `{id,label,desc}`
  | id | label | desc |
  |---|---|---|
  | `auto` | AUTO | 只读放行，bash 智能判定 |
  | `default` | DEFAULT | 写入 / 执行需确认 |
  | `acceptEdits` | ACCEPT-EDITS | 自动写文件，bash 仍确认 |
  | `plan` | PLAN | 只读，禁止写入 / 执行 |
  | `yolo` | YOLO | 全部自动，不确认 |
- **`SLASH`** (8): `{name,desc}` — see §6.
- **`TOOL_NAMES`** (raw tool → display label), `toolName(n) = TOOL_NAMES[n] || n`:
  `bash→Bash, edit_file→Edit, read_file→Read, write_file→Write, glob→Search, grep→Search, web_search→WebSearch, web_fetch→WebFetch, skill→Skill, ask_user_question→AskUser, agent→Agent, task_output→TaskOutput, task_stop→TaskStop`.

---

## 2. Backend Contract

### 2.1 Commands — `invoke(name, args) -> returns`

20 commands registered in Rust. Arg keys are what the **frontend passes** (camelCase where applicable). All void returns resolve `null`.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `app_info` | — | `{ model: string, mode: string, cwd: string, contextWindow: number }` | camelCase `contextWindow`. Boot. |
| `need_setup` | — | `bool` | Boot gate. |
| `save_api_key` | `{ key: string }` | `void` | Setup gate. |
| `list_sessions` | — | `Array<{ id: string, title: string, mtime: number }>` | `mtime` = unix seconds. |
| `resume_session` | `{ id: string }` | `Array<{ role: string, content: string, interrupted: bool }>` | `role` ∈ `user`\|`assistant`\|`summary`. |
| `new_session` | — | `Result<void>` | |
| `rename_session` | `{ title: string }` | `Result<void>` | |
| `balance` | — | `string \| null` | e.g. `"12.34 CNY"`. |
| `set_mode` | `{ mode: string }` | `Result<void>` | mode = a `MODES[].id`. |
| `approve` | `{ id: number, decision: string }` | `void` | decision ∈ `approve`\|`deny`\|`always`. **`edits` is never sent** (see §3 approval). |
| `answer` | `{ id: number, answers: Record<string,string> \| null }` | `void` | `null` = decline/cancel. Keyed by question text. |
| `submit` | `{ input: string }` | `void` | Empty input no-op; if busy, backend queues (no new turn). |
| `abort` | — | `void` | |
| `compact` | — | `Result<void>` | |
| `set_model` | `{ model: string }` | `void` | |
| `list_models` | — | `Array<{ value: string, label: string, description: string, current: bool }>` | |
| `get_settings` | — | settings object (snake_case, below) | |
| `save_settings` | `{ model, reasoningEffort, responseLanguage, turnSummary, tavilyKey?: string \| null }` | `void` | **camelCase args**; empty `tavilyKey` → `null` = keep unchanged. |
| `list_agents` | — | `Array<{ name, source, tools, model, when_to_use: string }>` | |
| `add_dir` | `{ path: string, persist: bool }` | `Result<string>` (status line) | |

`get_settings` return shape (snake_case fields):
```
{ model, reasoning_effort, response_language, turn_summary, tavily_set: bool,
  models: string[], reasoning_efforts: string[], response_languages: string[], turn_summaries: string[] }
```
Mock example: `reasoning_efforts:["none","low","medium","high","max","xhigh"]`, `response_languages:["auto","zh","zh-Hant","en","ja","ko"]`, `turn_summaries:["off","whole_turn","tool_only"]`.

### 2.2 Events — `agent-event` payload, dispatched on `e.kind`

**Unlisted kinds are silently ignored (no default case).** Streaming `thinking`/`content` carry **cumulative** text (replace, not append); `bashOutput` is the one append case.

| kind | Fields | Render behavior |
|---|---|---|
| `turnStarted` | `turn` | `setBusy(true)`; `clearLive()`; `renderLive()`. **Un-queue**: every `.msg.user.queued` loses `queued` class + inner `.q-badge`. |
| `thinking` | `text` | `liveThinking = text` (replace); `renderLive()`. |
| `content` | `text` | `liveContent = text` (replace); `renderLive()`. |
| `bashOutput` | `chunk` | `liveContent += chunk` (**append**, shares `liveContent`); `renderLive()`. |
| `assistant` | `content`, `interrupted?` | Commit assistant msg folding in `liveThinking` (§3 ToolCard/messages); `clearLive()`; `scrollDown()`. |
| `toolStarted` | `callId`, `name`, `summary` | `addToolCard` → running card, register in `toolCards`. |
| `toolFinished` | `callId`, `tag`, `ok`, `preview` | `finishToolCard` → ok/err dot, preview, overflow. |
| `subagentProgress` | `callId`, `turn`, `toolCalls`, `activity` (also `agentType` in mock) | Update `.sub-progress` line on agent card. |
| `subagentStep` | `callId`, `name`, `summary` | Append `.sub-step`, keep last 3. |
| `usage` | `input`, `output`, `cacheHit`, `cacheMiss`, `reasoning` | `renderUsage` → footer token line. |
| `bgTasks` | `running` | `bgtasksEl.text = running>0 ? \`⚙ ${running} 后台任务\` : ""`. |
| `recall` | `text` | Withdraw last `.msg.user`; if thread empty restore greeting; `input = text`; `autoGrow()`; `setBusy(false)`. |
| `turnComplete` | (none) | `setBusy(false)`; `clearLive()`; `loadSessions()`; `loadBalance()`. |
| `error` | `message` | `addError(message)`; `clearLive()`; `setBusy(false)`. |
| `approval` | `id`, `toolName`, `args` (JSON string), `warning?`, `savePatterns?: string[]` | `showApproval(e)`. |
| `question` | `id`, `items: Array<{ question, header?, options: string[], multiSelect: bool }>` | `showQuestion(e)`. |

**Backend busy coupling** (informational): the Rust forwarder flips busy based on raw `AgentEvent` before bridging — true on `TurnStarted`; false on `TurnComplete`, `Recall`, `Error`.

`approval.args` example: `'{"file_path":"src/auth/token.rs","old_string":"...","new_string":"..."}'` — a JSON **string**, pretty-printed by the UI.

---

## 3. Component Breakdown (SolidJS tree)

Proposed tree. Components emit the **exact** classes/ids listed; CSS keys off them. Kobalte primitives are suggested where a headless a11y widget helps, but **several places must stay native DOM** because `app.css` targets native semantics (notably `<details class="thinking">` and the `#overlay`/`#modal` singletons).

```
<App>                         #app (flex row, 100vh) + sibling #grain, #overlay, #toasts
├─ <Grain/>                   #grain (fixed SVG noise overlay)
├─ <Sidebar>                  #sidebar (246px)
│  ├─ <Brand/>                .brand [data-tauri-drag-region] > .dot
│  ├─ <NewChatButton/>        #new-chat > .plus
│  ├─ <SectionLabel/>         .section-label "最近会话"
│  ├─ <Sessions/>             #sessions > .session*
│  └─ <SidebarFoot>           .sidebar-foot
│     ├─ <ModeMenu/>          .foot-row(relative) > #mode.mode-btn + #mode-menu.menu + #balance.v
│     └─ <ModelRow/>          .foot-row > .k "模型" + #model.v
├─ <Main>                     #main
│  ├─ <Topbar/>               .topbar#topbar[.scrolled] > #title, #bgtasks, #usage, #theme-btn, #compact-btn
│  ├─ <Scroll>                #scroll (flex:1, scroll viewport)
│  │  ├─ <Greeting/>          #greeting (hidden once hasContent)
│  │  ├─ <Thread/>            #thread > <For> message renderers
│  │  └─ <Live/>              #live > .lt / .lc + .cursor
│  └─ <Composer>              #composer-wrap(relative)
│     ├─ <SlashMenu/>         #slash-menu.slash-menu[.open]
│     └─ <ComposerBox/>       #composer > #input(textarea) + .composer-row(#hint, .spacer, #send[.stop])
├─ <Overlay>                  #overlay[.on] > #modal[data-kind]
│  └─ (one of) <ApprovalModal>|<QuestionModal>|<ModelPicker>|<SettingsModal>|<AgentsModal>|<HelpModal>|<AddDirModal>|<SetupGate>
└─ <Toasts/>                  #toasts > .toast[.err]*
```

### 3.1 `<App>` shell
- Renders the layout, mounts `#grain`, `#overlay`, `#toasts` as siblings to `#app`.
- `onMount`: run boot flow (§1.2), `applyTheme(curTheme())`, subscribe `listen("agent-event", handleEvent)`.
- Owns the global keydown handler for modals (see §3.10) and the document-level click delegation (copy buttons, md-links, chips, mode-menu/slash-menu close).

### 3.2 `<Sidebar>` + `<Sessions>`
- **Sessions**: `<For>` over `state.sessions` (`{id,title,mtime}`). Each row:
  ```html
  <div class="session" classList={{active: id===activeId}} title={title} data-id={id}>
    <span class="s-title">{title}</span><span class="s-time">{relTime(mtime)}</span>
  </div>
  ```
  Click → `resumeSession(id)`. `.session.active::before` draws the left accent bar (needs `position:relative` on `.session`).
- **NewChat** `#new-chat`: `invoke("new_session")`, clear thread, title→"新对话", clear active, `loadSessions()`, focus input.
- **`relTime(secs)`**: 0/falsy→`""`; `<60`→`刚刚`; `<3600`→`N分`; `<86400`→`N时`; `<604800`→`N天`; else `N周`. `now = Date.now()/1000`.

### 3.3 `<ModeMenu>` (footer)
- Button `#mode.mode-btn`: `innerHTML = \`${label} <span class="caret">▾</span>\``. Click toggles `.open` on `#mode-menu.menu`.
- Menu items (per MODE):
  ```html
  <div class="menu-item" classList={{sel: id===modeId}}>
    <div><div>{label}</div><div class="desc">{desc}</div></div><span class="ck">✓</span>
  </div>
  ```
  Click: set `modeId`, update button label, `invoke("set_mode",{mode:id})`, close, `toast(\`审批模式 → ${label}\`)`.
- **Kobalte:** `DropdownMenu` is a candidate, **but** the menu must be a child of the `position:relative` `.foot-row` (CSS anchors `.menu` with `bottom: calc(100%+6px)`). If using Kobalte `DropdownMenu`, override its portal/positioning and ensure the rendered content carries `.menu`/`.menu.open` + `.menu-item`/`.sel`/`.ck`/`.desc`. Simpler to hand-roll with a `.open` signal. Document-level click closes it.

### 3.4 `<Topbar>`
- `#topbar.topbar`, toggles `.scrolled` when `#scroll` `scrollTop > 4`.
- `#title` ← session/thread title (ellipsis). `#bgtasks` (`.bgtasks:not(:empty)` styles only when populated). `#usage` (see renderUsage). `#theme-btn` (☀/☾), `#compact-btn` (`invoke("compact")` path also reachable via `/compact`).
- **`renderUsage(u)`** → `#usage` innerHTML, `u = {input,output,cacheHit,cacheMiss,reasoning}`:
  - Always: `<span class="u-tok">↑ {fmtTokens(input)} ↓ {fmtTokens(output)}</span>`.
  - If `cacheHit!=null && cacheMiss!=null && cacheHit+cacheMiss>0`: ` <span class="u-cache">缓存 {round(cacheHit/(cacheHit+cacheMiss)*100)}%</span>`.
  - If `ctxWindow>0`: ` <span class="u-ctx{ hi| mid|}">ctx {fmtTokens(input)}/{fmtTokens(ctxWindow)} ({pct}%)</span>`, `pct=round(input/ctxWindow*100)`; suffix `" hi"` if `pct>=80`, `" mid"` if `pct>=60`, else `""`.
  - If `reasoning`: ` <span class="u-think">推理 {fmtTokens(reasoning)}</span>`.
- **`fmtTokens(n)`**: `≥1e6→"x.xM"`; `≥1e4→"{round(n/1e3)}k"`; `≥1e3→"x.xk"`; else `String(n)`.
- **Theme:** `curTheme()` = `"dark"` if `<html data-theme>==="dark"` else `"light"`. `applyTheme(t)`: set `data-theme=t`; `themeBtn.text = t==="dark"?"☀":"☾"`; title accordingly. Click toggles, persists `localStorage["dd-theme"]=next`, toast `已切换到暗色/已切换到浅色`.

### 3.5 `<Thread>` + message renderers

`<For each={state.messages}>` dispatching on a `type` discriminant. Append-only. Each wrapper class owns its block spacing via CSS.

**`markActive()`** logic: first time real content appears, set `hasContent=true`, hide greeting. Re-show greeting when thread emptied (recall / clearThread / newChat).

#### `UserMessage` — `addUser(text, queued)`
```html
<div class="msg user" classList={{queued}}>
  <div class="role"><span class="pip"></span>你<Show when={queued}><span class="q-badge">排队中</span></Show></div>
  <div class="bubble">{text}</div>   <!-- escaped text, NOT markdown -->
</div>
```
- `queued` truthy (submitted while busy) → `.queued` + `.q-badge`. Both stripped on next `turnStarted`.
- If current title is `"DeepDive"` or `"新对话"`, set title from first user text (`text.trim().slice(0,60)`).
- `scrollDown()`.

#### `AssistantMessage` — `addAssistant(thinking, content, interrupted)`
```html
<div class="msg assistant" data-raw={content}>
  <div class="role"><span class="pip"></span>DeepDive</div>
  <Show when={content}><button class="msg-copy">复制</button></Show>
  <Show when={thinking.trim()}>
    <ThinkingBlock text={thinking}/>            <!-- §3.7 native details -->
  </Show>
  <Show when={content}><div class="body" innerHTML={md(content)}/></Show>
  <Show when={interrupted}><div class="interrupted">⎿ 已被用户中断</div></Show>
</div>
```
- `thinking` is escaped plain text inside the details body; `content` goes through `md()` into `.body`.
- `data-raw=content` powers `.msg-copy` (copy raw markdown source).
- `.msg-copy` is hidden until `.msg.assistant:hover` (CSS).

#### `AssistantPlainMessage` — `addAssistantPlain(content, interrupted)`
Resume-time variant (thinking not persisted): always copy button + `.body`, no thinking block. Same `data-raw`, same `.interrupted` mark.

#### `CompactDivider` — `addSummary(content)` (role `summary` on resume)
```html
<div class="compact-divider">
  <div class="cd-rule"><span>上下文已压缩 · 摘要如下</span></div>
  <div class="cd-body" innerHTML={md(content)}/>
</div>
```
Note: `.cd-body` does not inherit `.body` markdown rules unless also given `.body`; it has its own first/last-child resets in CSS. Render summary HTML into `.cd-body` (markdown via `md()`).

#### `ErrorRow` — `addError(msg)`
```html
<div class="err-row">⚠ {msg}</div>   <!-- textContent → escaped -->
```
`scrollDown()` after.

### 3.6 `<ToolCard>` — `toolStarted` / `toolFinished` / subagent

Structure (running state, from `addToolCard`):
```html
<div class="tool-card" classList={{subagent, previewed, overflow, open, expandable: headExpandable}}>
  <div class="tool-head" classList={{expandable}} onClick={open toggle when expandable}>
    <span class="tool-dot" classList={{run, ok, err}}></span>
    <span class="tool-name">{toolName(name)}</span>
    <span class="tool-sum">{summary}</span>
    <span class="tool-tag" classList={{err: !ok}}>{tag}</span>
    <span class="tool-chev" style={{display: overflow ? "" : "none"}}>▸</span>
  </div>
  <Show when={hasSubagentTrail}>
    <div class="sub-trail"><div class="sub-steps"><For>…<div class="sub-step">⎿ {name}({summary})</div></For></div><div class="sub-progress">{progressLine}</div></div>
  </Show>
  <div class="tool-preview" classList={{err: !ok, previewed}}>{previewLines}</div>
  <div class="tool-more">{… +N 行}</div>
  <div class="tool-body"><pre>{fullPreview}</pre></div>
</div>
```
- **Dot class is fully replaced** on finish: `run` → `ok` (ok) or `err` (not ok). Not additive.
- **Tag**: `tag || ""`; add `.err` to `.tool-tag` if `!ok`.
- **Preview formatting** (`finishToolCard`, when `preview.trim()` and not a QA result):
  - `lines = preview.replace(/\s+$/, "").split("\n")`.
  - `.tool-preview` text = first 3 lines joined `\n`, line 0 prefixed `⎿ ` (U+23BF + single space), lines 1–2 prefixed two spaces: `(idx ? "  " : "⎿ ") + l`.
  - `.tool-body pre` text = full `preview`.
  - add `.previewed`.
  - If `lines.length > 3`: add `.overflow`; `.tool-more` text = `… +{lines.length-3} 行`; show `.tool-chev`; `.tool-head` gets `.expandable` + click toggles `.open`.
- **Visibility is class-driven** (CSS): `.tool-card.previewed:not(.open) .tool-preview` shows preview only when previewed AND closed; `.tool-card.overflow:not(.open) .tool-more` likewise; `.tool-card.open .tool-body` reveals body + rotates chevron.
- **QA result** (`renderQA`): `ask_user_question` finished with a JSON `preview`. Try `JSON.parse(preview)`:
  - `obj.answers` (object): header `用户已回答：`, lines `· {q} → {a}`.
  - `obj.declined` (array): header `用户拒绝回答`, lines `· {q}`.
  - else fail → fall through to normal preview.
  - On success: `.tool-preview` text = `⎿ {header}\n   {line}\n   {line}…` (each line prefixed 3 spaces), add `.previewed`, **return** (no overflow logic).
- **Subagent trail** (`agent` tool card): lazily insert `<div class="sub-trail">` immediately after `.tool-head`, add `.subagent` to the card.
  - `subagentProgress`: `.sub-progress` text = `turn ${turn} · ${toolCalls} 工具调用${activity ? " · "+activity : ""}`.
  - `subagentStep`: append `<div class="sub-step">⎿ {name}({summary})</div>`; **keep only last 3** (remove firstChild while >3).
  - `.sub-progress:not(:empty)` styles only when non-empty.

### 3.7 `<ThinkingBlock>` — **must stay native `<details>`**

```html
<details class="thinking">
  <summary><span class="chev">▸</span>思考过程</summary>
  <div class="think-body">{thinking}</div>   <!-- escaped plain text -->
</details>
```
CSS relies on native `[open]` toggling, `::-webkit-details-marker` hiding, and `details.thinking[open] > summary .chev` rotation. **Do not** replace with a div + signal; use real `<details>`/`<summary>`. No Kobalte primitive — native is correct here.

### 3.8 `<Live>` — `renderLive()`

```js
stick = atBottom();         // BEFORE mutation; threshold: scrollHeight - scrollTop - clientHeight < 60
// rebuild #live:
if (liveThinking.trim()) -> <div class="lt">{liveThinking}</div>   // markActive(), plain text
if (liveContent || (busy && !liveThinking)) ->
   <div class="lc">{liveContent}</div><span class="cursor"></span>  // markActive(), plain text + cursor
if (stick) scrollDown();
```
- **Cursor shows even with empty content** while busy and no thinking → an empty `.lc` with a bare blinking `.cursor` appears at turn start.
- Plain text only (`textContent`), never markdown.
- In Solid: derive from `liveThinking`/`liveContent`/`busy` signals; capture `stick` in a pre-update read, re-apply scroll in an effect/`onMount` of the updated nodes.

### 3.9 `<Composer>` + `<SlashMenu>`

```html
<div id="composer-wrap">                              <!-- position:relative anchors slash menu -->
  <div id="slash-menu" class="slash-menu" classList={{open: slashOpen}}>
    <For each={slashItems}>
      <div class="slash-item" classList={{sel: i===slashSel}} data-i={i}
           onMouseDown={preventDefault + completeSlash(i)}>   <!-- mousedown beats blur -->
        <span class="sc-name">/{name}</span><span class="sc-desc">{desc}</span>
      </div>
    </For>
  </div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="给 DeepDive 发消息…"/>
    <div class="composer-row">
      <span class="hint" id="hint">{busy ? "运行中 · Esc 中断" : "Enter 发送 · Shift+Enter 换行"}</span>
      <span class="spacer"></span>
      <button id="send" classList={{stop: busy}}><span class="arrow">↑</span></button>
    </div>
  </div>
</div>
```
- **autoGrow()**: `height="auto"` then `height=min(scrollHeight,200)+"px"`. Called on input, completeSlash, history nav, submit, recall event, chip click.
- **`#send`**: `busy ? invoke("abort") : submit()`. `.stop` swaps to red square (CSS `::after` + hides `.arrow`).
- **`setBusy(b)`**: toggle `.stop` on `#send`; set `#hint` text. In Solid both derive from the `busy` signal.

**keydown precedence** (on `#input`):
1. **Slash open** (`slashOpen()`): `ArrowDown/Up` cycle `slashSel` (mod len, re-render); `Tab` or `Enter`(no shift) → `completeSlash(slashSel)`; `Escape` → `hideSlash()`. All `preventDefault` + return.
2. **History prev**: `ArrowUp` && caret on first line && (`histIdx!==-1` || history non-empty) → `historyPrev()`.
3. **History next**: `ArrowDown` && caret on last line && `histIdx!==-1` → `historyNext()`.
4. **Send**: `Enter` no shift → `preventDefault` + `submit()`.
5. **Abort**: `Escape` while busy → `invoke("abort")`. (Shift+Enter falls through to native newline.)

Caret helpers: `caretOnFirstLine` = no `\n` in `value.slice(0,selectionStart)`; `caretOnLastLine` = no `\n` in `value.slice(selectionStart)`; `caretToEnd` = `selectionStart=selectionEnd=value.length`.

`input` event: `autoGrow(); updateSlash(); histIdx=-1`. `blur`: `setTimeout(hideSlash, 120)`.

**`submit()`**:
```
text = input.value; if (!text.trim()) return;
if (cmdHistory.last !== text) cmdHistory.push(text);
histIdx=-1; histDraft="";
if (text.trim()[0] === "/") { hideSlash(); if(!dispatchSlash(text.trim())) toast(`未知命令：/${name}`,"err"); input=""; autoGrow(); return; }
addUser(text, busy);            // queued if mid-stream
input=""; autoGrow();
invoke("submit", {input: text});
```

**History recall**:
- `historyPrev()`: empty→return; if `histIdx===-1` stash `histDraft=value`, `histIdx=length`; if `histIdx>0` decrement, load `cmdHistory[histIdx]`, autoGrow, caretToEnd.
- `historyNext()`: `histIdx===-1`→return; increment; if `>=length` reset `histIdx=-1` + restore `histDraft`; else load entry; autoGrow + caretToEnd.

**Kobalte:** the slash menu is a custom autocomplete tied to textarea state — hand-roll it (Kobalte Combobox doesn't fit a textarea-prefix trigger). Keep `.slash-menu`/`.open`/`.slash-item`/`.sel`/`.sc-name`/`.sc-desc`.

### 3.10 Modals — `<Overlay>` + `#modal[data-kind]`

Single reusable shell: `#overlay > #modal`. `data-kind` ∈ `approval`|`question`|`info`|`setup`|`""`. Visibility via `.on` on `#overlay`.

```html
<div id="overlay" classList={{on: modalOpen}} onClick={backdrop}>
  <div id="modal" data-kind={kind} data-id={id?}>… kind-specific content …</div>
</div>
```
- `openModal()`/`closeModal()`: toggle `.on`, clear content + `data-kind` on close.
- **Backdrop click** closes **only `info`** modals (target must be the overlay itself).
- **Global keydown** (only when overlay `.on`), branch on `data-kind`:
  - `info` + `Escape` → close.
  - `approval`: `y→approve, n→deny, a→always, e→edits` (case-insensitive) → `approveWith(Number(dataId), d)` + close; `Escape` → `invoke("approve",{id,decision:"deny"})` + close.
  - `question`: see §3.10.2.
  - `setup`: **not dismissable** (no Esc/backdrop handler).
- In Solid: `<Switch>` on `kind` rendering the right modal component; `data-kind`/`data-id` still emitted on `#modal` for the keydown handler.
- **Kobalte `Dialog`** can host modal content for focus-trap/a11y, **but** you must preserve the `#overlay`/`#modal` ids, the `.on` class, and the `data-kind` attribute that the keyboard handlers and CSS depend on. Easiest: keep the singleton `#overlay > #modal` markup and use Kobalte only internally if at all. Approval/question/setup are **not** info-dismissable.

#### 3.10.1 `<ApprovalModal>` — `showApproval(e)`
`e = {id, toolName, args, warning?, savePatterns?}`. Pretty-print args: `try JSON.stringify(JSON.parse(e.args), null, 2)` else raw.
```html
<h3>批准工具<span class="tooltag">{toolName}</span></h3>
<div class="sub">DeepDive 想要执行以下工具调用</div>
<pre class="args">{args}</pre>
<Show when={warning}><div class="warn">⚠ {warning}</div></Show>
<div class="btns">
  <button class="btn primary" data-d="approve">同意 <span class="key">Y</span></button>
  <button class="btn danger"  data-d="deny">拒绝 <span class="key">N</span></button>
  <Show when={isEdit}>   <!-- toolName==="edit_file"||"write_file" -->
    <button class="btn" data-d="edits">本会话允许所有编辑 <span class="key">E</span></button></Show>
  <Show when={savePatterns?.length}>
    <button class="btn" data-d="always">永久允许 <span class="key">A</span></button></Show>
</div>
```
- `#modal` gets `data-kind="approval"`, `data-id=id`.
- Each button → `approveWith(id, data-d); closeModal()`.
- **`approveWith(id, decision)`**:
  - `decision==="edits"`: set `modeId="acceptEdits"`, `invoke("set_mode",{mode:"acceptEdits"})`, update mode button label, **then** `invoke("approve",{id,decision:"approve"})`. (`edits` is translated, never sent.)
  - else `invoke("approve",{id,decision})`.

#### 3.10.2 `<QuestionModal>` — `showQuestion(e)`
`e = {id, items:[{question, options:string[], multiSelect}]}` — sequential questions. State `qState = mkQ(e,qi)`:
```js
{ e, qi, sel:0, answers:(prevAnswers||{}), checked:new Set(), other:"", multi:!!items[qi].multiSelect }
```
`answers` carries across questions; `sel`/`checked`/`other` reset per question.

`renderQuestion()` (`#modal` `data-kind="question"`):
```html
<h3>{question}</h3>
<div class="sub">{qi+1} / {items.length} · {hint}</div>   <!-- hint: multi "Space 勾选 · Enter 提交 · Esc 取消" | single "↑↓ 选择 · Enter 确认 · Esc 取消" -->
<div class="q-opts">
  <For each={options}>
    <button class="btn opt" classList={{sel: idx===sel}} data-i={idx}>
      <Show when={multi}><span class="q-box">{checked.has(idx)?"☑":"☐"}</span></Show>
      <span>{opt}</span>
    </button>
  </For>
  <div class="q-other"><span class="q-olabel">其他</span>
    <input id="q-other" class="set-input" placeholder="自定义回答…" value={other}/></div>
</div>
<Show when={multi}><div class="btns"><button class="btn primary" id="q-submit">提交 <span class="key">↵</span></button></div></Show>
```
- Option click: multi → toggle `checked`, set `sel=i`, re-render; single → `commitAnswer(options[i])`.
- `#q-other`: `oninput` updates `qState.other`; `onkeydown` **stopPropagation** (keep arrows/space out of global handler); Enter → multi `submitMulti()` / single commit if non-empty; Escape → `invoke("answer",{id,answers:null})` + clear + close.
- **Global keydown** (`data-kind==="question"` && qState): `ArrowDown/Up` cycle `sel` mod n; `Space` (multi) toggle `checked[sel]`; `Enter` → multi `submitMulti()` / single `commitAnswer(options[sel])`; `Escape` → decline (`answers:null`). All `preventDefault`.
- **`submitMulti()`**: picks = sorted checked indices → options; append `other.trim()` if present; empty → `toast("请至少选择一项","err")`; else `commitAnswer(picks.join(", "))`.
- **`commitAnswer(value)`**: `answers[currentQuestionText]=value`; if last → `invoke("answer",{id,answers})` + clear + close; else advance `qState=mkQ(e,qi+1)`.

#### 3.10.3 `<ModelPicker>` — `openModelPicker()` (info kind)
Opened via `/model` or clicking `#model` (cursor pointer, title "切换模型"). `models = await invoke("list_models")` → `[{value,label,description,current}]`.
```html
<h3>选择模型</h3><div class="sub">点击切换 · 下一轮生效</div>
<div class="btns" style="flex-direction:column">
  <For>
    <button class="btn opt" classList={{sel: current}} data-v={value}>
      <span>{label} · {description}</span><Show when={current}><span class="ck">✓</span></Show>
    </button>
  </For>
</div>
```
Click: `invoke("set_model",{model:value})`; `#model` text = value; `toast(\`模型 → ${value}\`)`; close.

#### 3.10.4 `<SettingsModal>` — `openSettings()` (info kind, `/settings`)
`s = await invoke("get_settings")`.
```html
<h3>设置</h3><div class="sub">保存后下一轮生效</div>
<div class="settings-grid">
  <label>模型</label>      <select id="set-model"   class="set-input">…s.models / s.model…</select>
  <label>推理强度</label>  <select id="set-reason"  class="set-input">…s.reasoning_efforts / s.reasoning_effort…</select>
  <label>回复语言</label>  <select id="set-lang"    class="set-input">…s.response_languages / s.response_language…</select>
  <label>轮次摘要</label>  <select id="set-summary" class="set-input">…s.turn_summaries / s.turn_summary…</select>
  <label>Tavily Key</label><input id="set-tavily" type="password" class="set-input"
        placeholder={s.tavily_set ? "已设置（留空保持不变）" : "tvly-…"}>
</div>
<div class="btns"><button class="btn primary" id="set-save">保存</button>
  <button class="btn" data-close>取消 ⟨Esc⟩</button></div>
```
Save: `invoke("save_settings",{ model:set-model.value, reasoningEffort:set-reason.value, responseLanguage:set-lang.value, turnSummary:set-summary.value, tavilyKey: set-tavily.value || null })`; `#model` text = set-model.value; `toast("设置已保存")`; close. **Note camelCase args vs snake_case `get_settings` fields.**

#### 3.10.5 `<AgentsModal>` — `openAgents()` (info kind, `/agents`)
`agents = await invoke("list_agents")` → `[{name,source,tools,model,when_to_use}]`.
```html
<h3>子代理<span class="tooltag">{agents.length}</span></h3>
<div class="sub">由模型通过 task 工具调用</div>
<div class="agent-list">
  <Show when={empty}><div class="sub">未找到子代理</div></Show>
  <For>
    <div class="agent-row">
      <div class="ar-head"><span class="ar-name">{name}</span><span class="ar-src">{source}</span><span class="ar-meta">{tools} · {model}</span></div>
      <div class="ar-desc">{when_to_use}</div>
    </div>
  </For>
</div>
<button class="btn primary" data-close>关闭 ⟨Esc⟩</button>
```
Read-only; no per-row invoke.

#### 3.10.6 `<HelpModal>` — `showHelp()` (info kind, `/help`)
```html
<h3>命令</h3><div class="sub">输入 / 触发命令</div>
<div class="help-list">
  <For each={SLASH sorted alpha}>
    <div class="help-row"><span class="hc-name">/{name}</span><span class="hc-desc">{desc}</span></div>
  </For>
</div>
<button class="btn primary" data-close>知道了 ⟨Esc⟩</button>
```

#### 3.10.7 `<AddDirModal>` — `doAddDir(path)` (info kind, `/add-dir <path>`)
Empty path → `toast("用法：/add-dir <路径>","err")`. Else:
```html
<h3>添加工作目录</h3><div class="sub">允许在此目录外读写而无需每次确认</div>
<pre class="args">{path}</pre>
<div class="btns">
  <button class="btn primary" id="ad-session">当前会话</button>      <!-- apply(false) -->
  <button class="btn" id="ad-persist">工作区所有会话</button>        <!-- apply(true) -->
  <button class="btn danger" data-close>取消 ⟨Esc⟩</button>
</div>
```
`apply(persist)`: close, `invoke("add_dir",{path,persist})` → toast result (err toast on throw).

#### 3.10.8 `<SetupGate>` — `showSetup()` (kind `setup`, **non-dismissable**)
Shown when `need_setup` is true; gates the app.
```html
<h3>欢迎使用 DeepDive</h3>
<div class="sub">请输入 DeepSeek API Key 以开始（保存在本机 ~/.deepdive/settings.json）</div>
<input id="setup-key" class="set-input" type="password" placeholder="sk-…">
<div class="warn" id="setup-err" style="display:none"></div>
<div class="btns" style="margin-top:14px"><button class="btn primary" id="setup-save">保存并开始 <span class="key">↵</span></button></div>
<div class="sub" style="margin-top:12px">在 platform.deepseek.com 获取 API Key</div>
```
- `#setup-key` focused. No `data-close`, no Esc/backdrop dismissal.
- `save()`: trim; empty → show `#setup-err` "⚠ API Key 不能为空"; else `invoke("save_api_key",{key})`, close, `toast("API Key 已保存")`, `afterSetup()`. Trigger on button click or Enter in the key input.

> **No dedicated setup-gate CSS exists.** SetupGate reuses the modal shell + `.set-input` + `.btn.primary`. Acceptable; do not invent new classes.

### 3.11 `<Toasts>`
- `#toasts` container; `toast(msg, kind?)` appends `<div class="toast {kind}">msg</div>`, auto-removed after **2600ms**. `.toast.err` = red. Dark theme overrides toast bg.
- In Solid: a `toasts[]` signal of `{id,msg,kind}`; `<For>`; remove after 2600ms.

---

## 4. Markdown Module Spec (`md.ts`)

**Signature:** `export function renderMarkdown(text: string | null | undefined): string` — returns a **bare HTML-string fragment** (no root element), injected via `innerHTML` into `.body` / `.cd-body`. No sanitization is applied by the caller. Also assign to `window.renderMarkdown` if other code reads it globally.

Internal helpers (not exported but required): `esc`, `inline`, `highlightCode`, `span`, `renderDiff`, `render`.

### 4.1 Escaping (`esc`)
`s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")` — **only** `&`, `<`, `>`. Quotes are NOT escaped here (link URLs escape `"`→`&quot;` separately).

### 4.2 Block parsing (`render`)
1. `(src ?? "").replace(/\r\n?/g,"\n").split("\n")`.
2. Buffer plain lines into `para[]`; `flushP()` emits `<p>`.
3. Per line, first match wins: **fenced code → heading → hr → blockquote → table → list → blank(flush) → paragraph**.
4. `inline()` applies to paragraph/heading/blockquote/list-item/table-cell text. **Never inside code blocks.**

| Block | Detect | Output |
|---|---|---|
| Heading | `/^(#{1,4})\s+(.*)$/` (levels 1–4 only; 5+ = paragraph) | `<h{n}>{inline(text)}</h{n}>` |
| Paragraph | non-blank, non-block, buffered, joined `\n` | `<p>{inline(joined).replace(/\n/g,"<br>")}</p>` |
| HR | `/^\s*([-*_])\1\1+\s*$/` (≥3 identical) | `<hr>` |
| Blockquote | `/^\s*>\s?/` per line, fold consecutive | `<blockquote>{inline(text).replace(/\n/g,"<br>")}</blockquote>` (no nesting) |
| List | item `/^\s*([-*+]|\d+\.)\s+/`; ordered iff first line `/^\s*\d+\.\s+/` | `<ul>`/`<ol>` of `<li>{inline(item)}</li>`. **Flat — no nesting**; indentation discarded. |
| Table | line has `|` AND next line matches `/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/` | `<table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr>…</tbody></table>`. **Alignment colons ignored**; body rows consumed while `/\|/.test(line)` && non-empty. Cell split: strip outer `|`, `split("|")`, trim. |

### 4.3 Inline (`inline(raw)`) — order matters
1. `esc(raw)`.
2. **Inline code protection**: `` /`([^`]+)`/g `` → pull each into `codes[]`, replace with placeholder ` N ` (space-index-space). Reinserted step 7.
3. **Links**: `/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g` → `<a class="md-link" title="{url}">{text}</a>`. URL `"`→`&quot;`. **No `href` — only `title` carries the URL** (the doc-level click handler copies `title`).
4. **Bold**: `/\*\*([^*]+)\*\*/g` and `/__([^_]+)__/g` → `<strong>$1</strong>`.
5. **Strikethrough**: `/~~([^~]+)~~/g` → `<del>$1</del>`.
6. **Italic**: `/(^|[^*])\*([^*\s][^*]*?)\*/g` → `$1<em>$2</em>`; `/(^|[^_\w])_([^_\s][^_]*?)_/g` → `$1<em>$2</em>`.
7. **Inline code reinsert**: `/ (\d+) /g` → `<code class="inline">{codes[+i]}</code>`. **Content reinserted RAW (un-escaped)** — store the original backtick inner text and inject verbatim.

### 4.4 Fenced code blocks
Open `/^\s*```(\w*)/`, close `/^\s*```/`, lang lowercased.
- **`diff`/`patch`** → `renderDiff(code)` (§4.6).
- **Else**:
  ```html
  <div class="code-block"><div class="code-head">
    <span class="lang">{esc(lang||"code")}</span>
    <button class="copy" data-code="{encodeURIComponent(code)}">复制</button>
  </div><pre><code>{highlightCode(code,lang)}</code></pre></div>
  ```

### 4.5 Syntax highlighter (`highlightCode(code, lang)`)
Forward scanner emitting `<span class="tok-{cls}">{esc(text)}</span>` via `span(cls,text)`; non-token chars `esc`'d raw. Classes: `tok-com, tok-str, tok-num, tok-key, tok-lit, tok-fn, tok-type`.

Scan order per position:
| Match | Class |
|---|---|
| `//…EOL`, or `#…EOL` if lang ∈ HASH_COMMENT | `tok-com` |
| `/* … */` (consumes close, clamp to end) | `tok-com` |
| `"…"` `'…'` `` `…` `` (`\` escapes next) | `tok-str` |
| digit, or `.`+digit; runs `[0-9a-fA-FxXoObB._]` | `tok-num` |
| word `[A-Za-z0-9_$]` not starting with digit | see below |
| anything else | (no span) esc'd char |

Word classification (peek past spaces for next non-space `code[k]`): in `KEYWORDS`→`tok-key`; else in `LITERALS`→`tok-lit`; else next non-space is `(`→`tok-fn`; else first char `A–Z`→`tok-type`; else plain `esc(word)`.

```
KEYWORDS = fn def function func return if else elif for while loop match switch case
  break continue const let var mut pub use import from export default class struct enum
  trait impl interface type async await yield new delete try catch except finally raise
  throw with as in of is and or not where do then end module package namespace extends
  implements override abstract final unsafe dyn ref move crate mod typeof instanceof void
  public private protected static lambda pass global del assert print echo local readonly declare
LITERALS = true false True False None nil null undefined NaN self this super
HASH_COMMENT = python py bash sh shell zsh yaml yml ruby rb toml ini conf perl pl r make makefile dockerfile
```
`isWord(c)`: `a-z|A-Z|0-9|_|$`. `isDigit(c)`: `0-9`.

### 4.6 Diff blocks (`renderDiff(code)`)
Strip one trailing `\n`, split `\n`. Per row:
| Test | `dl` class | counter |
|---|---|---|
| `/^@@/` | `hunk` | — |
| `/^(\+\+\+\|---\|diff \|index )/` | `meta` | — |
| `row[0]==="+"` | `add` | added++ |
| `row[0]==="-"` | `del` | removed++ |
| else | `ctx` | — |

Each row → `<div class="dl {cls}">{esc(r) || "​"}</div>` (empty rows get zero-width space).
```html
<div class="code-block diff"><div class="code-head">
  <span class="lang">diff</span>
  <span class="diff-stat"><span class="d-add">+{added}</span><span class="d-del">−{removed}</span></span>
  <button class="copy" data-code="{encodeURIComponent(code)}">复制</button>
</div><div class="diff-body">{rows}</div></div>
```
Stat minus is U+2212 `−` (not ASCII `-`). No highlighting in diff mode.

### 4.7 Emitted class inventory (must match exactly)
Block/chrome: `code-block`, `code-block diff`, `code-head`, `lang`, `copy`, `diff-stat`, `d-add`, `d-del`, `diff-body`, `dl`, `dl add/del/hunk/meta/ctx`. Inline: `md-link` (`<a>`), `inline` (`<code>`). Tokens: `tok-key/lit/str/num/com/fn/type`. Plain tags: `p h1–h4 hr blockquote ul ol li table thead tbody tr th td pre code strong del em br a`.

### 4.8 Quirks to preserve
- Headings 1–4 only. Lists flat. Tables ignore alignment. Links: `title` not `href`. Inline code reinserted **unescaped**. `esc` ignores quotes. `data-code` uses `encodeURIComponent`. Diff minus = U+2212; empty diff rows = `​`. Output is a fragment string.

---

## 5. CSS Strategy

**Reuse `dist/app.css` verbatim.** It is pure, framework-agnostic CSS — no Tailwind/utility/preprocessor/CSS-in-JS. Copy the whole file into the Solid app and import once.

### 5.1 Theming
- Tokens on `:root`, overridden by `:root[data-theme="dark"]` (lines 4–79). Toggle via `data-theme` on `<html>`. Accent blue `#61afef` is **locked in both themes** (do not change; user memory: "Running blue locked").
- Dark theme also re-defines non-token rules (`body` gradient, `#grain` blend, scrollbar thumb, `.toast` fill, `.tok-*`, diff `.dl.add/.del`). Keep these compound `:root[data-theme="dark"] …` selectors intact.

### 5.2 DOM-structure constraints components MUST honor
The CSS leans heavily on **id singletons**, descendant/child combinators, **state classes**, and **native element semantics**. Reproduce exactly:

1. **ID singletons** (render exactly one of each, same id): `#app #grain #sidebar #sessions #new-chat #main #topbar #title #bgtasks #usage #theme-btn #compact-btn #scroll #greeting #thread #live #composer-wrap #composer #input #send #mode #mode-menu #balance #model #overlay #modal #toasts #slash-menu #hint`.
2. **Role/state modifier classes** (drive visibility + theming): `.msg.user` / `.msg.assistant` / `.msg.user.queued`; tool card `.open .previewed .overflow .subagent .expandable` + dot `.run/.ok/.err`; `.menu.open`, `.slash-menu.open`, `.topbar.scrolled`, `#overlay.on`, `.session.active`, `.menu-item.sel`, `.opt.sel`, `.slash-item.sel`, `#send.stop`.
3. **Native `<details class="thinking">/<summary>`** — `[open]`, `::-webkit-details-marker`, chevron rotation are browser-native. Do not replace with a div+signal.
4. **Positioning anchors**: `.menu` must be inside a `position:relative` `.foot-row` (anchors `bottom:calc(100%+6px)`); `.slash-menu` must be inside `position:relative` `#composer-wrap` (`bottom:calc(100%-2px)`); `.msg-copy` must be a child of `.msg.assistant` (hover reveal); `.session.active::before` needs `.session{position:relative}`; markdown body under `.body`; tool sub-parts inside `.tool-card`/`.tool-head`; `#modal pre.args` and `#modal h3 .tooltag` inside `#modal`.
5. **Content-presence selectors**: `.bgtasks:not(:empty)` and `.sub-progress:not(:empty)` style only when populated — render an always-present empty element; it stays invisible until filled.
6. **Markdown body class**: assistant prose container must be `.body` (markdown rules all target `.body …`); inline code must be `<code class="inline">`. `.cd-body` has its own resets (add `.body` too only if you want full markdown rules — match original: summary HTML goes in `.cd-body` via `md()`).
7. **`.brand` `padding-left:82px`** is tuned for the macOS traffic-light inset on the frameless window. Keep `data-tauri-drag-region` on `.brand` and `.topbar`.
8. **Keyframes** (`rise fade pop blink pulse`) are referenced across regions — keep the block intact. `prefers-reduced-motion` kills durations.

WebKit scrollbar styling is fine for the Tauri WKWebView target.

---

## 6. Slash Commands

`SLASH` list (filter is prefix-match on bare command, alpha-sorted):

| name | desc |
|---|---|
| `model` | 切换模型（pro / flash） |
| `settings` | 运行时设置 |
| `agents` | 列出可用子代理 |
| `add-dir` | 添加额外工作目录 |
| `rename` | 重命名当前会话 |
| `compact` | 压缩对话以节省上下文 |
| `clear` | 清空当前对话 |
| `help` | 显示可用命令 |

**Autocomplete:** `slashQuery()` returns the lowercased fragment after `/` **only if** `value[0]==="/"` AND value has **no whitespace** (still typing the bare name); else `null`. `updateSlash()`: `null`→hide; else `SLASH.filter(c=>c.name.startsWith(q)).sort(localeCompare)`; empty→hide; clamp `slashSel`; render. `completeSlash(i)`: `input = "/"+name+" "` (trailing space → `slashQuery` returns null → menu auto-closes), hide, autoGrow, focus.

**Dispatch** `dispatchSlash(text)`: `name = text.slice(1).split(/\s+/)[0].toLowerCase()`, `arg = text.slice(1+name.length).trim()`. Returns true if handled.

| command | action |
|---|---|
| `help` | `showHelp()` (info modal, no invoke) |
| `clear` | `newChat()` → `invoke("new_session")` + reset + `loadSessions()` |
| `compact` | `invoke("compact")` + `toast("已请求压缩对话")` |
| `model` | `openModelPicker()` → `list_models` / `set_model` |
| `settings` | `openSettings()` → `get_settings` / `save_settings` |
| `agents` | `openAgents()` → `list_agents` |
| `rename` | `doRename(arg)`: empty→err toast "用法：/rename <新标题>"; else `await invoke("rename_session",{title:arg})`, set title `arg.slice(0,60)`, toast `已重命名：{arg}`, `loadSessions()`; throw→err toast |
| `add-dir` / `adddir` | `doAddDir(arg)` (§3.10.7) |
| _default_ | return false → caller `toast("未知命令：/{name}","err")` |

---

## 7. State Management Plan (Solid store)

Use a single `createStore` for structured state plus a few `createSignal`s for high-churn streaming values. Suggested shape:

```ts
// --- structured store ---
const [state, setState] = createStore({
  // thread (committed, append-only)
  messages: [] as Msg[],            // discriminated union, see below
  hasContent: false,                // greeting visibility (false → show greeting)

  // turn / status
  busy: false,
  modeId: "auto" as ModeId,
  model: "",                        // footer/topbar model label
  contextWindow: 0,                 // for ctx %
  balance: "" as string,            // "" hides
  usage: null as Usage | null,      // {input,output,cacheHit,cacheMiss,reasoning}
  bgTasks: 0,                       // running count → "⚙ N 后台任务" when >0
  title: "DeepDive",                // thread/session title

  // tool calls (keyed by callId)
  tools: {} as Record<string, ToolCard>,

  // sessions sidebar
  sessions: [] as Session[],        // {id,title,mtime}
  activeSessionId: null as string | null,

  // modal (single shell)
  modal: null as ModalState | null, // {kind:"approval"|"question"|"info"|"setup", ...payload}

  // theme
  theme: "light" as "light" | "dark",
});

// --- high-churn signals (avoid store-diff cost on every stream chunk) ---
const [liveThinking, setLiveThinking] = createSignal("");  // replace on `thinking`
const [liveContent,  setLiveContent]  = createSignal("");  // replace on `content`, append on `bashOutput`
const [toasts, setToasts] = createSignal<Toast[]>([]);

// --- non-reactive refs (plain vars/refs) ---
let cmdHistory: string[] = [];
let histIdx = -1;
let histDraft = "";
let qState: QState | null = null;      // active question modal machine
let slashItems: SlashItem[] = [];      // (signal if menu re-renders reactively)
let slashSel = 0;
const toolCardEls = new Map<string, HTMLElement>(); // only if hand-rolling DOM; prefer store `tools`
```

**Message discriminated union** (`messages[]`):
```ts
type Msg =
  | { type:"user"; text:string; queued:boolean }
  | { type:"assistant"; thinking:string; content:string; interrupted:boolean; hasThinking:boolean }
  | { type:"assistantPlain"; content:string; interrupted:boolean }   // resume path
  | { type:"summary"; content:string }                                // compact divider
  | { type:"error"; message:string }
  | { type:"tool"; callId:string };                                   // renders <ToolCard> from state.tools[callId]
```
Tool cards can either live inline in `messages` (a `tool` marker referencing `state.tools[callId]`) so ordering with text is preserved, or be tracked separately — **inline ordering matters** (tools interleave with text in arrival order), so keep a `tool` marker in `messages` and the mutable card data in `state.tools`.

```ts
type ToolCard = {
  name:string; summary:string;
  dot:"run"|"ok"|"err";
  tag:string; tagErr:boolean;
  previewLines:string[];           // formatted (⎿ + 2-space lines)
  fullPreview:string;
  previewed:boolean; overflow:boolean; overflowMore:string; open:boolean;
  isSubagent:boolean; subSteps:string[]; subProgress:string;   // subSteps capped at 3
};
type Usage = { input:number; output:number; cacheHit:number; cacheMiss:number; reasoning:number };
type ModalState =
  | { kind:"approval"; id:number; toolName:string; args:string; warning?:string; savePatterns?:string[] }
  | { kind:"question"; id:number; items:QItem[] }
  | { kind:"info"; view:"model"|"settings"|"agents"|"help"|"addDir"; data?:any }
  | { kind:"setup" };
```

**Rationale:** store for structured/discrete state (good fine-grained updates), raw signals for `liveThinking`/`liveContent` (re-set many times per second — cheaper than store diffing), plain vars for imperative machinery (`cmdHistory`, `qState`, slash nav) that don't need reactivity.

---

## 8. Edge Cases & Gotchas

1. **Live vs committed split is load-bearing.** `#live` = plain text + `.cursor`; `#thread` = markdown, append-only. On `assistant`, fold live thinking → committed `<details class="thinking">`, content → `.body` (markdown), then clear live. Never render markdown in live.
2. **Cumulative vs append streaming.** `thinking` and `content` are full-replace (cumulative prefix slices, not deltas). `bashOutput` is the only **append** (`liveContent += chunk`) — and it shares `liveContent` with `content`.
3. **Cursor with empty content.** Live content block + cursor render even when `liveContent` is empty, as long as `busy && !liveThinking` → an empty `.lc` with a bare blinking cursor at turn start. Condition: `liveContent || (busy && !liveThinking)`.
4. **Block spacing in CSS only.** All gaps between `.msg` / `.tool-card` / `.compact-divider` / `.err-row` come from CSS keyed on these wrappers. Never add inline `margin-top`.
5. **Mid-turn queueing.** Submitting while `busy` optimistically renders a user bubble with `.queued` + `.q-badge` ("排队中"). On the next `turnStarted`, strip `.queued` and remove the `.q-badge` from all queued bubbles (they become normal bubbles).
6. **First-turn interruption (`recall`).** `recall` withdraws the **last** `.msg.user` back into the composer: remove it; if thread now empty restore greeting (`hasContent=false`); `input.value = e.text`; `autoGrow()`; `setBusy(false)`.
7. **Mid-turn history recall.** `↑` on first caret line walks back through `cmdHistory` (stashing the live draft into `histDraft` first); `↓` on last line walks forward, restoring `histDraft` at the end. `histIdx=-1` = not recalling; any input keystroke resets `histIdx=-1`. Slash commands ARE pushed to history (push happens before the slash branch).
8. **Tool dot fully replaced.** On finish, dot class goes from `tool-dot run` to `tool-dot ok` or `tool-dot err` — replace, not add (drop `run`).
9. **Tool preview alignment.** Line 0 → `⎿ ` (U+23BF + single space); lines 1–2 → two leading spaces. Overflow (>3 lines) → `.overflow`, `.tool-more` = `… +N 行`, show `.tool-chev`, expandable head toggling `.open`. QA results bypass overflow logic and return early.
10. **`⎿` single trailing space** everywhere (interrupted mark `⎿ 已被用户中断`, sub-steps, QA preview, tool preview). Never two spaces.
11. **Subagent steps capped at 3** (remove oldest). `.sub-progress` styled only when non-empty.
12. **Compaction divider.** Built from a `role==="summary"` message on resume → `.compact-divider` with `.cd-rule` label and `.cd-body` (markdown). It is part of the transcript flow, not a modal.
13. **`acceptEdits` switch on approval.** The approval `E` / "本会话允许所有编辑" decision (`edits`) is **never sent as a decision**: it flips `modeId="acceptEdits"`, calls `invoke("set_mode",{mode:"acceptEdits"})`, updates the mode button label, then sends `invoke("approve",{id,decision:"approve"})`. The `edits` button only appears for `edit_file`/`write_file`; `always` only when `savePatterns.length`.
14. **Scroll-stick.** Only auto-scroll the live region when `atBottom()` (threshold: `scrollHeight - scrollTop - clientHeight < 60`) was true **before** the update. Committed builders mostly `scrollDown()` unconditionally. `#topbar` toggles `.scrolled` when `scrollTop > 4`.
15. **Modal dismissal rules.** Backdrop click and Esc close **only `info`** modals. `approval`/`question` have their own keyboard handlers (and answer-cancel sends `answers:null` / approval-Esc sends `decision:"deny"`). `setup` is **non-dismissable** (no Esc/backdrop). `#q-other` input keydown calls `stopPropagation()` so typing doesn't trigger the global arrow/space handlers.
16. **Theme persistence + no-flash.** Pre-paint inline script sets `<html data-theme>` from `localStorage["dd-theme"]` (default `"light"`) before any framework code. `applyTheme` in app only syncs the button + sets the attr; toggle persists to `dd-theme`. Accent `#61afef` is locked in both themes.
17. **Busy guards.** `resumeSession` while `busy` → `toast("运行中，无法切换会话")` and abort (don't switch).
18. **Greeting lifecycle.** Hidden on first content via `markActive()`; re-shown on `clearThread`/`newChat`/`recall` (when thread empties).
19. **`bgtasksEl` / `usageEl` cleared by `clearThread`** (also on `newChat`/session switch). `clearThread` resets: empties `#thread`, `clearLive()`, clears tool map, `hasContent=false`, restore greeting, `setBusy(false)`, clear bgtasks + usage.
20. **WKWebView / Safari target.** The app runs in Tauri's WKWebView (macOS) — Safari-class engine. Avoid Chromium-only APIs; `-webkit-scrollbar` and `-webkit-details-marker` are intentionally used and fine. `navigator.clipboard.writeText` is used for copy buttons (`.copy[data-code]` → `decodeURIComponent`, label → `已复制` 1200ms), `.msg-copy` (copies closest `.msg` `data-raw`, 1200ms), `a.md-link` (copies `title`, toast `已复制链接`), and `.chip[data-q]` (fills input + `submit()`). Wire these via document-level delegation in `<App>` since they target markdown-emitted nodes that Solid does not own.
21. **6 commands absent from the mock** (`approve`, `answer`, `abort`, `set_mode`, `new_session`, `compact`) fall through the mock's `default: null` (all effectively void) — add explicit no-op cases in the dev mock for clarity, or rely on the fallthrough. The real backend implements all 20.
22. **Mock event gaps.** The mock never emits `recall` or `error` UiEvents; implement those handlers anyway (they fire from the real backend). Stream events emit cumulative text — renderer replaces.
