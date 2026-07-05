#!/usr/bin/env bash
# Test: does changing `tools` break DeepSeek prefix cache?
#
# Strategy:
#   1. Request A: warm-up with fixed messages + ALL_TOOLS
#   2. Wait 5s for cache build
#   3. Request B: SAME messages + empty tools []
#   4. Compare prompt_cache_hit_tokens
#      - If B hits ~same tokens as A's prompt → tools change does NOT break cache
#      - If B has 0 cache hits → tools change DOES break cache (messages prefix lost)
#
# Run: bash scripts/test_tools_cache.sh
set -euo pipefail

# Read config from settings.json
SETTINGS="$HOME/.deepdive/settings.json"
if [ ! -f "$SETTINGS" ]; then
  echo "ERROR: $SETTINGS not found" >&2
  exit 1
fi

API_KEY=$(jq -r '.env.DEEPSEEK_API_KEY // empty' "$SETTINGS")
BASE_URL=$(jq -r '.env.DEEPSEEK_BASE_URL // "https://api.deepseek.com"' "$SETTINGS")
MODEL=$(jq -r '.DEEPSEEK_MODEL // "deepseek-v4-pro"' "$SETTINGS")

if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
  echo "ERROR: DEEPSEEK_API_KEY not set in $SETTINGS" >&2
  exit 1
fi

URL="${BASE_URL}/chat/completions"

# Fixed messages (long enough for meaningful cache hit)
MESSAGES='[
  {"role":"system","content":"You are a helpful assistant."},
  {"role":"user","content":"Tell me a very short joke. Reply with ONLY the joke and nothing else. No setup, no commentary."}
]'

# Emulate ALL_TOOLS — we only need the array to be present and non-empty
FULL_TOOLS='[
  {"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to file"}},"required":["file_path"]}}},
  {"type":"function","function":{"name":"write_file","description":"Write a file","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to file"},"content":{"type":"string","description":"Content"}},"required":["file_path","content"]}}},
  {"type":"function","function":{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string","description":"Command to run"}},"required":["command"]}}},
  {"type":"function","function":{"name":"grep","description":"Search file contents","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"Pattern to search for"}},"required":["pattern"]}}},
  {"type":"function","function":{"name":"glob","description":"Find files by pattern","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}}
]'

send_request() {
  local tools="$1"
  local label="$2"

  local body
  body=$(jq -n \
    --arg model "$MODEL" \
    --argjson messages "$MESSAGES" \
    --argjson tools "$tools" \
    '{
      model: $model,
      messages: $messages,
      max_tokens: 100,
      stream: false,
      tools: $tools
    }')

  echo "=== $label ===" >&2
  echo "tools length: $(echo "$tools" | jq 'length')" >&2

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
    echo "$json_body" >&2
    return 1
  fi

  local prompt_tokens
  prompt_tokens=$(echo "$json_body" | jq '.usage.prompt_tokens // 0')
  local cache_hit
  cache_hit=$(echo "$json_body" | jq '.usage.prompt_cache_hit_tokens // 0')
  local cache_miss
  cache_miss=$(echo "$json_body" | jq '.usage.prompt_cache_miss_tokens // 0')

  echo "  prompt_tokens: $prompt_tokens" >&2
  echo "  cache_hit:     $cache_hit" >&2
  echo "  cache_miss:    $cache_miss" >&2
  echo "" >&2

  echo "$cache_hit"
}

echo "=== DeepDive tools-cache test ===" >&2
echo "Model: $MODEL" >&2
echo "URL: $URL" >&2
echo "" >&2

# Request A: warm-up with FULL tools
HIT_A=$(send_request "$FULL_TOOLS" "Request A (warm-up, full tools)")

echo "Waiting 4 seconds for cache build..." >&2
sleep 4

# Request B: SAME messages, EMPTY tools
HIT_B=$(send_request '[]' "Request B (same messages, empty tools)")

echo "=== Result ===" >&2
echo "Request A cache hit: $HIT_A tokens" >&2
echo "Request B cache hit: $HIT_B tokens" >&2

if [ "$HIT_B" -gt 0 ]; then
  echo "" >&2
  echo "✅ Request B had cache hits → tools change does NOT break messages prefix cache" >&2
  echo "   Stripping tools in side-question is safe." >&2
else
  echo "" >&2
  echo "❌ Request B had ZERO cache hits → tools change BREAKS messages prefix cache" >&2
  echo "   Stripping tools in side-question would lose cache benefit." >&2
fi
