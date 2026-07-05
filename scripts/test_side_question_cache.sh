#!/usr/bin/env bash
# Test: does a side-question with empty tools break the MAIN session's prefix cache?
#
# Scenario:
#   Turn 1: main conversation (message A + tools full) → warms cache
#   Turn 2: main conversation (message B + tools full) → should HIT cache from turn 1
#   Turn 3: main conversation (message C + tools full) → should HIT cache from turns 1+2
#   Side Q: same prefix as turn 3 BUT tools empty            → what happens?
#   Turn 4: main conversation (message D + tools full) → does it STILL hit cache?
#
set -euo pipefail

SETTINGS="$HOME/.deepdive/settings.json"
API_KEY=$(jq -r '.env.DEEPSEEK_API_KEY // empty' "$SETTINGS")
BASE_URL=$(jq -r '.env.DEEPSEEK_BASE_URL // "https://api.deepseek.com"' "$SETTINGS")
MODEL=$(jq -r '.DEEPSEEK_MODEL // "deepseek-v4-pro"' "$SETTINGS")
URL="${BASE_URL}/chat/completions"

FULL_TOOLS='[
  {"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}},
  {"type":"function","function":{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}},
  {"type":"function","function":{"name":"grep","description":"Search file contents","parameters":{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]}}}
]'

# Build a persistent multi-turn history (3 turns)
SYS='{"role":"system","content":"You are DeepDive, a coding agent. Answer concisely in Chinese."}'
T1U='{"role":"user","content":"介绍一下 Golang 的 goroutine 是什么"}'
T1A='{"role":"assistant","content":"goroutine 是 Go 语言的轻量级协程，由 Go runtime 调度，比操作系统线程更轻量。通过 go 关键字启动，使用 channel 进行通信。"}'
T2U='{"role":"user","content":"那和 Rust 的 async 有什么区别"}'
T2A='{"role":"assistant","content":"核心区别：goroutine 是抢占式调度（runtime 自动挂起/恢复），Rust async 是协作式（需要显式 .await 让出）。goroutine 栈可动态增长，Rust async 编译成状态机无独立栈。goroutine 使用 GMP 模型调度，Rust async 由 executor（如 tokio）调度。"}'
T3U='{"role":"user","content":"Python 的 asyncio 又是怎么实现的"}'
T3A='{"role":"assistant","content":"Python asyncio 使用事件循环（event loop）模型，基于 epoll/kqueue 等系统调用。async/await 将协程编译成生成器状态机，由事件循环统一调度。3.11+ 引入 task groups 改进结构化并发。"}'
T4U='{"role":"user","content":"Node.js 呢"}'

# For side-question: same prefix but tools=empty
T3_SIDE='{"role":"user","content":"<system-reminder>side question</system-reminder>\n\n刚才说的 Rust async 和 Node.js 的 event loop 是类似的吗"}'

send() {
  local tools_json="$1"
  local label="$2"
  local msgs="$3"

  body=$(jq -n \
    --arg model "$MODEL" \
    --argjson messages "$msgs" \
    --argjson tools "$tools_json" \
    '{model:$model, messages:$messages, max_tokens:200, stream:false, tools:$tools}')

  local response
  response=$(curl -s -w '\n%{http_code}' "$URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$body")
  local http_code=$(echo "$response" | tail -1)
  local json_body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo "  ERROR HTTP $http_code" >&2
    return 1
  fi

  local pt=$(echo "$json_body" | jq '.usage.prompt_tokens // 0')
  local hit=$(echo "$json_body" | jq '.usage.prompt_cache_hit_tokens // 0')
  local miss=$(echo "$json_body" | jq '.usage.prompt_cache_miss_tokens // 0')

  echo "$label|prompt_tokens=$pt|cache_hit=$hit|cache_miss=$miss"
}

echo "=== Side-Question Cache Impact Test ===" >&2
echo "Model: $MODEL" >&2
echo "" >&2

# --- Turn 1: warm up ---
HIST_1="[$SYS,$T1U]"
RESULT=$(send "$FULL_TOOLS" "Turn 1 (warm-up)" "$HIST_1")
echo "  $RESULT"

# --- Turn 2: should hit cache ---
HIST_2="[$SYS,$T1U,$T1A,$T2U]"
RESULT=$(send "$FULL_TOOLS" "Turn 2 (should hit)" "$HIST_2")
echo "  $RESULT"

# --- Turn 3: should hit more cache ---
HIST_3="[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U]"
RESULT=$(send "$FULL_TOOLS" "Turn 3 (should hit)" "$HIST_3")
echo "  $RESULT"

# --- Side Question: tools EMPTY ---
SIDE_HIST="[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U,$T3_SIDE]"
echo "" >&2
echo ">>> Side Question (empty tools) <<<" >&2
RESULT=$(send '[]' "Side Q (empty tools)" "$SIDE_HIST")
echo "  $RESULT"

# --- Turn 4: back to main, should STILL hit cache if side q didn't kill it ---
HIST_4="[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U,$T3A,$T4U]"
echo "" >&2
echo ">>> Turn 4 (back to main, full tools) <<<" >&2
RESULT=$(send "$FULL_TOOLS" "Turn 4 (main again)" "$HIST_4")
echo "  $RESULT"

echo "" >&2
echo "=== Analysis ===" >&2
echo "If Turn 4 still has cache_hit > 0 → side-question empty tools did NOT kill main cache." >&2
echo "If Turn 4 cache_hit = 0 → side-question empty tools DID kill/evict main cache." >&2
