#!/usr/bin/env bash
# Test v2: with realistic-length messages, test public prefix detection
#
# Does DeepSeek's "公共前缀检测落盘" mechanism cache the messages-only
# prefix when tools differ between requests?
#
# Strategy:
#   Phase A — seed two requests with SAME long messages, DIFFERENT tools
#             (triggers public-prefix detection on messages-only portion)
#   Phase B — third request, same messages, a THIRD tool set
#             (check if messages portion was cached independently)
#   Phase C — same messages, empty tools []
#             (direct test of side-question's stripped-tools scenario)
set -euo pipefail

SETTINGS="$HOME/.deepdive/settings.json"
API_KEY=$(jq -r '.env.DEEPSEEK_API_KEY // empty' "$SETTINGS")
BASE_URL=$(jq -r '.env.DEEPSEEK_BASE_URL // "https://api.deepseek.com"' "$SETTINGS")
MODEL=$(jq -r '.DEEPSEEK_MODEL // "deepseek-v4-pro"' "$SETTINGS")
if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then echo "ERROR: no API key" >&2; exit 1; fi

URL="${BASE_URL}/chat/completions"

# Build a realistic-length messages array (~500+ tokens) — simulates a
# multi-turn conversation like DeepDive's main_history.
LONG_MSGS=$(jq -n '
[
  {"role":"system","content":"You are DeepDive, a terminal coding agent. You help with software engineering tasks — reading and editing files, running shell commands, searching code, and debugging."},
  {"role":"user","content":"Find all TypeScript files that import from react-router-dom"},
  {"role":"assistant","content":"Let me search for that. I will grep for react-router-dom in the src directory.","tool_calls":[{"id":"call_1","type":"function","function":{"name":"grep","arguments":"{\"pattern\":\"react-router-dom\",\"path\":\"src\"}"}}]},
  {"role":"tool","tool_call_id":"call_1","content":"src/App.tsx: import { BrowserRouter, Routes, Route } from \"react-router-dom\";\nsrc/components/Layout.tsx: import { NavLink } from \"react-router-dom\";"},
  {"role":"assistant","content":"Found 2 files:\n1. src/App.tsx — uses BrowserRouter, Routes, Route\n2. src/components/Layout.tsx — uses NavLink"},
  {"role":"user","content":"Now check if there are any deprecated react-router v5 APIs being used in those files. Look for Switch, withRouter, useHistory, or BrowserRouter import patterns from the past"},
  {"role":"assistant","content":"Good question. Let me read both files to check for deprecated APIs.","tool_calls":[{"id":"call_2","type":"function","function":{"name":"read_file","arguments":"{\"file_path\":\"src/App.tsx\"}"}},{"id":"call_3","type":"function","function":{"name":"read_file","arguments":"{\"file_path\":\"src/components/Layout.tsx\"}"}}]},
  {"role":"tool","tool_call_id":"call_2","content":"import React from \"react\";\nimport { BrowserRouter, Routes, Route } from \"react-router-dom\";\nimport Home from \"./pages/Home\";\nimport About from \"./pages/About\";\nfunction App() {\n  return (\n    <BrowserRouter>\n      <Routes>\n        <Route path=\"/\" element={<Home />} />\n        <Route path=\"/about\" element={<About />} />\n      </Routes>\n    </BrowserRouter>\n  );\n}\nexport default App;"},
  {"role":"tool","tool_call_id":"call_3","content":"import { NavLink } from \"react-router-dom\";\nfunction Layout() {\n  return (\n    <nav>\n      <NavLink to=\"/\">Home</NavLink>\n      <NavLink to=\"/about\">About</NavLink>\n    </nav>\n  );\n}\nexport default Layout;"},
  {"role":"assistant","content":"Both files are using react-router v6 APIs. No deprecated v5 APIs found:\n- BrowserRouter ✓ (current)\n- Routes ✓ (replaces deprecated Switch)\n- Route ✓\n- NavLink ✓"},
  {"role":"user","content":"你很厲害，但我想知道你對這個問題的看法：如果所有可能的編程工作都由 AI 在 5 年內完成，人類程式設計師該怎麼辦？用繁體中文回答，簡短一點，3 句話以內。"}
]')

echo "=== DeepDive tools-cache test v2 (realistic-length messages) ===" >&2
echo "Model: $MODEL" >&2
echo "Messages size: $(echo "$LONG_MSGS" | jq 'length') messages, $(echo "$LONG_MSGS" | jq -r 'map(.content // "") | join("") | length') chars" >&2
echo "" >&2

# Three different tool sets
TOOLS_SET_A='[{"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}},{"type":"function","function":{"name":"write_file","description":"Write a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]}}},{"type":"function","function":{"name":"bash","description":"Run shell","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]'
TOOLS_SET_B='[{"type":"function","function":{"name":"grep","description":"Search files","parameters":{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]}}},{"type":"function","function":{"name":"glob","description":"Find files","parameters":{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]}}},{"type":"function","function":{"name":"edit_file","description":"Edit file","parameters":{"type":"object","properties":{"file_path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["file_path","old_string","new_string"]}}}]'
TOOLS_SET_C='[{"type":"function","function":{"name":"web_search","description":"Search web","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},{"type":"function","function":{"name":"web_fetch","description":"Fetch URL","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}}]'

send_request() {
  local tools="$1"
  local label="$2"

  local body
  body=$(jq -n \
    --arg model "$MODEL" \
    --argjson messages "$LONG_MSGS" \
    --argjson tools "$tools" \
    '{
      model: $model,
      messages: $messages,
      max_tokens: 150,
      stream: false,
      tools: $tools
    }')

  echo "=== $label ===" >&2
  echo "tools count: $(echo "$tools" | jq 'length')" >&2

  local response
  response=$(curl -s -w '\n%{http_code}' \
    "$URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$body")

  local http_code
  http_code=$(echo "$response" | tail -1)
  local json_body
  json_body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo "ERROR: HTTP $http_code" >&2
    echo "$json_body" | jq . 2>/dev/null || echo "$json_body" >&2
    return 1
  fi

  local prompt_tokens
  prompt_tokens=$(echo "$json_body" | jq '.usage.prompt_tokens // 0')
  local cache_hit
  cache_hit=$(echo "$json_body" | jq '.usage.prompt_cache_hit_tokens // 0')
  local cache_miss
  cache_miss=$(echo "$json_body" | jq '.usage.prompt_cache_miss_tokens // 0')
  local finish_reason
  finish_reason=$(echo "$json_body" | jq -r '.choices[0].finish_reason // "?"')

  echo "  prompt_tokens: $prompt_tokens" >&2
  echo "  cache_hit:     $cache_hit" >&2
  echo "  cache_miss:    $cache_miss" >&2
  echo "  finish_reason: $finish_reason" >&2
  echo "" >&2

  echo "${cache_hit}|${cache_miss}|${prompt_tokens}"
}

echo "=== Phase A: Seed common prefix with TWO requests (different tools) ===" >&2
echo "This triggers DeepSeek's 公共前缀检测 to cache the messages-only portion." >&2
echo "" >&2

HIT_A1=$(send_request "$TOOLS_SET_A" "Phase A-1: messages + tools set A")
sleep 2

HIT_A2=$(send_request "$TOOLS_SET_B" "Phase A-2: messages + tools set B (DIFFERENT tools!)")
echo "Phase A-2 is the 2nd request — if it has cache hits, the messages prefix is cached." >&2
echo "" >&2

echo "Waiting 5 seconds for cache build..." >&2
sleep 5

echo "=== Phase B: Third request with YET ANOTHER tool set ===" >&2
echo "If messages prefix was cached independently, this should hit it." >&2
echo "" >&2

HIT_B=$(send_request "$TOOLS_SET_C" "Phase B: messages + tools set C (third set)")
sleep 2

echo "=== Phase C: EMPTY tools (side-question scenario) ===" >&2
echo "" >&2

HIT_C=$(send_request "[]" "Phase C: messages + EMPTY tools (side-question)")

echo "" >&2
echo "=== Results ===" >&2

IFS='|' read -r h1 m1 p1 <<< "$HIT_A1"
IFS='|' read -r h2 m2 p2 <<< "$HIT_A2"
IFS='|' read -r hb mb pb <<< "$HIT_B"
IFS='|' read -r hc mc pc <<< "$HIT_C"

echo "Phase A-1 (tools set A):   hit=${h1:-0} miss=${m1:-0} total=${p1:-0}" >&2
echo "Phase A-2 (tools set B):   hit=${h2:-0} miss=${m2:-0} total=${p2:-0}" >&2
echo "Phase B   (tools set C):   hit=${hb:-0} miss=${mb:-0} total=${pb:-0}" >&2
echo "Phase C   (empty tools):   hit=${hc:-0} miss=${mc:-0} total=${pc:-0}" >&2
echo "" >&2

if [ "${h2:-0}" -gt 0 ]; then
  echo "✅ Phase A-2 had cache hits → messages prefix WAS cached after 1st request" >&2
else
  echo "❌ Phase A-2 had ZERO cache hits → messages prefix was NOT cached after 1st request" >&2
fi

if [ "${hb:-0}" -gt 0 ]; then
  echo "✅ Phase B (third tool set) → messages prefix IS cached independently of tools" >&2
  echo "   => stripping tools in side-question preserves cache!" >&2
else
  echo "⚠️  Phase B missed → tools ARE part of cache key even with long messages" >&2
  echo "   But maybe the public-prefix detection didn't trigger in Phase A?" >&2
fi

if [ "${hc:-0}" -gt 0 ]; then
  echo "✅ Phase C (empty tools) → also hits cache!" >&2
  echo "   => side-question can safely strip tools" >&2
else
  echo "❌ Phase C (empty tools) → cache miss" >&2
  echo "   => stripping tools in side-question WOULD lose cache" >&2
fi

echo "" >&2
echo "=== Cache hit percentage summary ===" >&2
for entry in "A-1:h1:m1" "A-2:h2:m2" "B:hb:mb" "C:hc:mc"; do
  IFS=':' read -r l h m <<< "$entry"
  h_val="${!h:-0}"
  m_val="${!m:-0}"
  total=$((h_val + m_val))
  if [ "$total" -gt 0 ]; then
    pct=$((h_val * 100 / total))
    echo "  $l: ${pct}% hit ($h_val/$total)" >&2
  fi
done
