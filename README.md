# DeepDive

**DeepSeek-native terminal coding agent** — an interactive AI assistant built on DeepSeek V4, running entirely in your terminal.

![pro](https://img.shields.io/badge/model-deepseek--v4--pro-blue)
![flash](https://img.shields.io/badge/model-deepseek--v4--flash-orange)
![MIT](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **DeepSeek V4 native** — Purpose-built for DeepSeek's API, leveraging reasoning, 1M context window, and tool-call loops.
- **Rich TUI** — Built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals). Markdown rendering, code blocks with syntax highlighting, tables, thinking blocks.
- **8 built-in tools** — `read_file`, `edit_file`, `write_file`, `bash`, `grep`, `glob`, `web_search`, `web_fetch` — everything a coding agent needs.
- **Skill system** — Loadable, reusable skill modules (like `/commit`) that inject instructions and run as slash commands.
- **Session persistence** — JSONL-based append-only logging. Resume any session with `-r` or `-c`.
- **Context management** — Auto-compaction at ~80% token window with a configurable summary strategy (`off`, `whole_turn`, `tool_only`).
- **Inline bash mode** — Prefix input with `!` to run local shell commands without going through the API.
- **Permission system** — Fine-grained instruction-level access control (allow/deny/ask) with a read-command whitelist.
- **Approval modes** — `default` / `acceptEdits` / `plan` / `yolo` / `auto`, switchable with Shift+Tab.
- **Model switching** — Toggle between `pro` and `flash` via `/model` or `/settings`.
- **Turn summary** — Compress previous tool-call rounds into a summary to save tokens without losing user intent.
- **Proxy support** — HTTP proxy via `http_proxy` environment variable.

---

## Installation

```bash
npm install -g @mrbone11/deepdive
```

Or run from source:

```bash
git clone https://github.com/senweiliang/DeepDive.git
cd DeepDive
pnpm install
pnpm build
pnpm start
```

### Requirements

- **Node.js** >= 18
- **pnpm** (for development)

---

## Usage

```bash
deepdive               Start a new session
deepdive -r            Open session picker to resume a past session
deepdive -r <id>       Resume a specific session by ID
deepdive -c            Continue the most recent session
deepdive -h            Show help
```

On first launch, you'll be prompted to enter your DeepSeek API key. It's saved to `~/.deepdive/settings.json`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | API key (or set via the setup screen) |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Model name |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL |
| `DEEPSEEK_REASONING_EFFORT` | `high` | Reasoning effort level |
| `DEEPSEEK_MAX_TOKENS` | `32000` | Max output tokens |
| `DEEPSEEK_SUMMARY_MODEL` | `deepseek-v4-flash` | Model used for turn/context summaries |
| `DEEPDIVE_TURN_SUMMARY_STRATEGY` | `off` | `off`, `whole_turn`, or `tool_only` |
| `DEEPDIVE_REQUEST_AUDIT` | — | `summary` or `full` — log API request bodies |
| `DEEPDIVE_MODE` | — | Initial approval mode |
| `http_proxy` | — | HTTP proxy URL |

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear the current conversation |
| `/compact` | Manually trigger context compaction |
| `/model` | Switch between pro and flash models |
| `/settings` | Adjust runtime settings (model, mode, summary strategy, etc.) |

Type `/` in the input box to see available commands.

---

## Skills

Skills are reusable modules that extend DeepDive with custom workflows. They live in `~/.deepdive/skills/` and are invoked via `/` slash commands.

Built-in skills include:

- **`/commit`** — Analyze workspace changes, generate a conventional commit message, stage, commit, and push.

---

## Approval Modes

Cycle with **Shift+Tab** in the input box:

| Mode | Behavior |
|------|----------|
| **default** | Confirm every write/edit/bash operation |
| **acceptEdits** | Auto-accept file edits, confirm bash |
| **plan** | Tool results visible but never executed |
| **yolo** | Auto-accept everything |
| **auto** | Classifier decides — simple commands pass, complex ones prompt |

Permissions can be saved per-command pattern in `/settings` for persistent rules.

---

## Session Persistence

Sessions are stored as append-only JSONL files in `~/.deepdive/sessions/`. Each session logs:

- Metadata (start time, working directory, model)
- Messages (user + assistant + tool calls/results)
- Compaction events
- Token usage

Resume with `-r` (picker) or `-c` (last session).

---

## Tools

DeepDive exposes 8 tools to the model:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional offset/limit |
| `write_file` | Create or overwrite a file |
| `edit_file` | Find-and-replace in an existing file |
| `bash` | Execute shell commands |
| `grep` | Search file contents with regex |
| `glob` | Find files matching a glob pattern |
| `web_search` | Search the web (powered by Tavily) |
| `web_fetch` | Fetch and extract content from a URL |

---

## Key Bindings

| Key | Action |
|-----|--------|
| `Enter` | Send message / confirm |
| `Escape` | Abort streaming / cancel |
| `Tab` | Autocomplete slash command |
| `Shift+Tab` | Cycle approval modes |
| `↑` / `↓` | Navigate suggestions / history |
| `Ctrl+C` | Exit |
| `!` prefix | Inline bash mode |

---

## Project Structure

```
src/
├── cli.tsx               # Entry point, argument parsing
├── client.ts             # DeepSeek API client (SSE streaming)
├── config.ts             # Configuration loader
├── session.ts            # Session persistence (JSONL)
├── skills.ts             # Skill system
├── types.ts              # Shared TypeScript types
├── theme.ts              # One Dark Code color palette
├── net.ts                # Proxy-aware fetch
├── turn-summary.ts       # Turn-level summarization
├── balance.ts            # Token balance tracking
├── log.ts                # Audit logging
├── commands/             # Slash command modules
│   ├── clear.ts, compact.ts, model.ts, settings.ts
│   └── types.ts
├── components/           # Ink TUI components
│   ├── App.tsx, Chat.tsx, InputBox.tsx, Header.tsx
│   ├── Footer.tsx, Block.tsx, ToolResult.tsx
│   ├── ConfirmBox.tsx, Thinking.tsx, Running.tsx
│   ├── Markdown.tsx, ModelPanel.tsx, SettingsPanel.tsx
│   ├── SessionPicker.tsx, SetupScreen.tsx
│   └── ...
└── tools/                # Tool implementations
    ├── schema.ts, executor.ts, format.ts
    ├── permissions.ts, approval.ts, classifier.ts
    ├── webfetch.ts, websearch.ts
    └── ...
```

---

## Development

```bash
# Install dependencies
pnpm install

# Run in dev mode (with auto-reload)
pnpm dev

# Typecheck
pnpm typecheck

# Run tests
pnpm test

# Build
pnpm build
```

### Design Principles

- **Prefix-cache friendly** — Tool schemas are sorted alphabetically, prompt segments are ordered from static to dynamic.
- **Append-only** — Messages are never mutated in place; compaction appends summary markers without rewriting history.
- **Error-resilient** — Disk write failures, API errors, and streaming interruptions are handled gracefully without crashing the TUI.

See [docs/DESIGN.md](docs/DESIGN.md) for detailed architecture decisions.

---

## License

MIT
