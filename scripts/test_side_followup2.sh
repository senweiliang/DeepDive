#!/usr/bin/env bash
set -euo pipefail

SETTINGS="$HOME/.deepdive/settings.json"
API_KEY=$(jq -r '.env.DEEPSEEK_API_KEY // empty' "$SETTINGS")
BASE_URL=$(jq -r '.env.DEEPSEEK_BASE_URL // "https://api.deepseek.com"' "$SETTINGS")
MODEL=$(jq -r '.DEEPSEEK_MODEL // "deepseek-v4-pro"' "$SETTINGS")
URL="${BASE_URL}/chat/completions"

FULL_TOOLS='[{"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}},{"type":"function","function":{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]'

SYS='{"role":"system","content":"You are a helpful assistant with expertise in programming languages, system design, and software engineering. Always answer in Chinese with detailed explanations."}'
T1U='{"role":"user","content":"请详细解释一下Go语言的goroutine是什么，它和传统线程有什么区别？"}'
T1A='{"role":"assistant","content":"Go语言的goroutine是一种轻量级的并发执行单元。主要区别有：\n\n1. 调度方式：goroutine由Go运行时调度（GMP模型），在用户态完成；线程由操作系统内核调度。\n\n2. 创建成本：goroutine初始栈2KB可动态增长；线程栈通常8MB。\n\n3. 切换开销：goroutine用户态切换约50ns；线程内核态切换约1μs。\n\n4. 通信机制：goroutine提倡channel（CSP模型）；线程常用共享内存+锁。\n\n5. 数量：一个Go程序可创建数十万goroutine；线程几千个就达到瓶颈。"}'
T2U='{"role":"user","content":"那goroutine和Rust的async/await机制有什么区别？Rust的async是基于状态机的对吧？"}'
T2A='{"role":"assistant","content":"是的，两者本质区别如下：\n\n调度模型：goroutine抢占式调度（编译器自动插入抢占点）；Rust async协作式（通过.await显式挂起）。\n\n栈与状态：goroutine有独立动态栈；Rust async编译成状态机无独立栈，跨越.await持有锁受限。\n\n运行时：Go内置运行时；Rust async运行时由第三方提供（tokio等）。\n\n性能：goroutine创建约300ns；Rust async创建约20ns。goroutine百万级占~4GB；Rust async千万级可行。"}'
T3U='{"role":"user","content":"那Python的asyncio是怎么实现的？它在底层用了什么机制？"}'
Q1U='{"role":"user","content":"side asyncio vs goroutine"}'
Q2A='{"role":"assistant","content":"placeholder answer"}'
Q2U='{"role":"user","content":"tell me more"}'

send() {
  local body="$1" label="$2"
  local response
  response=$(curl -s -w "\n%{http_code}" "$URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$body")
  local http_code=$(echo "$response" | tail -1)
  local json_body=$(echo "$response" | sed '$d')
  [ "$http_code" != "200" ] && { echo "$label ERROR HTTP $http_code"; return 1; }
  local pt=$(echo "$json_body" | jq '.usage.prompt_tokens // 0')
  local hit=$(echo "$json_body" | jq '.usage.prompt_cache_hit_tokens // 0')
  local miss=$(echo "$json_body" | jq '.usage.prompt_cache_miss_tokens // 0')
  echo "$label|pt=$pt|hit=$hit|miss=$miss"
}

build() {
  jq -n --argjson m "$1" --argjson t "$2" \
    '{model:"deepseek-v4-pro",messages:$m,max_tokens:200,stream:false,tools:$t}'
}

echo "=== T1 (warm) ==="
send "$(build "[$SYS,$T1U]" "$FULL_TOOLS")" "T1"
sleep 4

echo "=== T2 (full tools) ==="
send "$(build "[$SYS,$T1U,$T1A,$T2U]" "$FULL_TOOLS")" "T2"
sleep 4

echo "=== T3 (full tools) ==="
send "$(build "[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U]" "$FULL_TOOLS")" "T3"
sleep 5

echo "=== Q1 empty tools ==="
send "$(build "[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U,$Q1U]" "[]")" "Q1"
sleep 4

echo "=== Q2 empty tools followup ==="
send "$(build "[$SYS,$T1U,$T1A,$T2U,$T2A,$T3U,$Q1U,$Q2A,$Q2U]" "[]")" "Q2"
