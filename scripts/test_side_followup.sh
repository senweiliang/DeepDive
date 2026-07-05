#!/usr/bin/env bash
# Test: side question follow-up cache behavior with empty tools
# Does Q2 (empty tools) hit Q1 (empty tools)'s cache?
set -euo pipefail

SETTINGS="$HOME/.deepdive/settings.json"
API_KEY=$(jq -r '.env.DEEPSEEK_API_KEY // empty' "$SETTINGS")
BASE_URL=$(jq -r '.env.DEEPSEEK_BASE_URL // "https://api.deepseek.com"' "$SETTINGS")
MODEL=$(jq -r '.DEEPSEEK_MODEL // "deepseek-v4-pro"' "$SETTINGS")
URL="${BASE_URL}/chat/completions"

FULL_TOOLS='[{"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}},{"type":"function","function":{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]'

SYS='{"role":"system","content":"You are DeepDive, a coding agent."}'
T1U='{"role":"user","content":"goroutine是什么"}'
T1A='{"role":"assistant","content":"Go轻量级协程。"}'
T2U='{"role":"user","content":"Rust async区别"}'
T2A='{"role":"assistant","content":"goroutine抢占，Rust协作。"}'
T3U='{"role":"user","content":"Python asyncio呢"}'

send() {
  local body="$1" label="$2"
  local response
  response=$(curl -s -w "\n%{http_code}" "$URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$body")
  local http_code=$(echo "$response" | tail -1)
  local json_body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo "  $label ERROR HTTP $http_code"
    echo "  body: $(echo "$json_body" | head -c 200)"
    return 1
  fi

  local pt=$(echo "$json_body" | jq '.usage.prompt_tokens // 0')
  local hit=$(echo "$json_body" | jq '.usage.prompt_cache_hit_tokens // 0')
  local miss=$(echo "$json_body" | jq '.usage.prompt_cache_miss_tokens // 0')
  echo "$label|pt=$pt|hit=$hit|miss=$miss"
  echo "$json_body" > /dev/null # store for later if needed
}

# Build body helper
build() {
  jq -n --argjson messages "$1" --argjson tools "$2" '{
    model:"deepseek-v4-pro",
    messages:$messages,
    max_tokens:50,
    stream:false,
    tools:$tools
  }'
}

echo "=== Turn 1 ==="
H1="[$SYS,$T1U]"
send "$(build "$H1" "$FULL_TOOLS")" "Turn 1"

echo "=== Turn 2 ==="
H2="[$SYS,$T1U,$T1A,$T2U]"
send "$(build "$H2" "$FULL_TOOLS")" "Turn 2"

echo "=== Turn 3 ==="
H3="[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U]"
send "$(build "$H3" "$FULL_TOOLS")" "Turn 3"

echo "--- wait 5s ---"
sleep 5

echo "=== Side Q1 (empty tools) ==="
H_Q1="[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U,{\"role\":\"user\",\"content\":\"side q1\"}]"
send "$(build "$H_Q1" "[]")" "Side Q1"

echo "=== Side Q2 (empty tools, follow-up) ==="
H_Q2="[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U,{\"role\":\"user\",\"content\":\"side q1\"},{\"role\":\"assistant\",\"content\":\"dummy answer\"},{\"role\":\"user\",\"content\":\"side q2\"}]"
send "$(build "$H_Q2" "[]")" "Side Q2"
