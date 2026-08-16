#!/usr/bin/env bash
# scripts/e2e.sh — dsh-web-gateway 蓝绿切换端到端验收脚本。
#
# 用法: DSH_BIN=<path-to-dsh> bash scripts/e2e.sh
# 需要: 本机可运行 `dsh web`（会写 $DSH_HOME）；网关端口默认 8181。
set -uo pipefail
cd "$(dirname "$0")/.."

GW_PORT="${GW_PORT:-8181}"
CTRL_PORT=$((GW_PORT + 0x1000))
LOG=/tmp/gw-e2e-$$.log
PASS=0; FAIL=0

check() { # check "<name>" "<expected>" "<actual>"
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1));
  else echo "  ✗ $1 (expected $2, got $3)"; FAIL=$((FAIL+1)); fi
}

echo "== 0) 清理残留（仅按确切 PID，绝不碰 5100）=="
for pid in $(lsof -tiTCP:$GW_PORT -sTCP:LISTEN 2>/dev/null); do
  ps -p $pid -o cmd= | grep -q 'index.js up' && kill $pid 2>/dev/null
done
for pid in $(lsof -tiTCP:$CTRL_PORT -sTCP:LISTEN 2>/dev/null); do
  ps -p $pid -o cmd= | grep -q 'index.js up' && kill $pid 2>/dev/null
done
sleep 1

echo "== 1) up：拉起 active + 网关 =="
DSH_GATEWAY_LOGS_DIR=/tmp/gw-e2e-logs node index.js up --port $GW_PORT --profile web > /tmp/gw-e2e-up.log 2>&1 &
DAEMON=$!
sleep 8
CODE=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:$GW_PORT/ 2>/dev/null)
check "gateway GET / => 200" "200" "$CODE"

PRE=$(node index.js status --port $GW_PORT 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"]["active"]["port"])')
echo "  (pre-switch active=$PRE)"

echo "== 2) open-update：蓝绿切换 =="
MSG=$(node index.js open-update --port $GW_PORT 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"].get("message",""))')
check "open-update switched" "switched" "$MSG"
POST=$(node index.js status --port $GW_PORT 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"]["active"]["port"])')
[ "$PRE" != "$POST" ] && echo "  ✓ active 端口变化 ($PRE -> $POST)" && PASS=$((PASS+1)) || { echo "  ✗ active 端口未变"; FAIL=$((FAIL+1)); }
CODE=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:$GW_PORT/ 2>/dev/null)
check "切换后同地址 GET / => 200" "200" "$CODE"

echo "== 3) 失败注入：不存在的 patch → 自动回滚 =="
MSG=$(node index.js open-update --port $GW_PORT -p /tmp/definitely-not-exist.yml 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"].get("message",""))')
check "staging-failed 且未切换" "not-switched:staging-failed" "$MSG"
POST2=$(node index.js status --port $GW_PORT 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"]["active"]["port"])')
check "active 未受影响" "$POST" "$POST2"
CODE=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:$GW_PORT/ 2>/dev/null)
check "网关继续服务" "200" "$CODE"

echo "== 4) 空闲保护：持 WS 无 force → active-busy =="
cat > /tmp/gw-e2e-hold.mjs <<EOF
import { WebSocket } from '${WS_IMPORT:-/home/qingqi/.nvm/versions/node/v26.7.0/lib/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs}';
const ws = new WebSocket('ws://127.0.0.1:$GW_PORT/api/events.host', { headers: { Host: 'gw.x', Origin: 'https://gw.x' } });
ws.on('open', () => console.log('HOLDING'));
setInterval(() => {}, 30000);
EOF
node /tmp/gw-e2e-hold.mjs > /tmp/gw-e2e-hold.log 2>&1 &
HOLD=$!
sleep 2
MSG=$(node index.js open-update --port $GW_PORT 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"].get("message",""))')
check "active-busy 拒绝切换" "not-switched:active-busy" "$MSG"
kill $HOLD 2>/dev/null
sleep 2

echo "== 5) WS 释放后再切 =="
MSG=$(node index.js open-update --port $GW_PORT 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"].get("message",""))')
check "再次切换成功" "switched" "$MSG"

echo "== 6) 5100 完好性（若存在）=="
if lsof -iTCP:5100 -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  echo "  ✓ 5100 (DSH GUI) 仍在监听（未被波及）"
  PASS=$((PASS+1))
fi

kill $DAEMON 2>/dev/null
echo ""
echo "== 结果: PASS=$PASS FAIL=$FAIL =="
[ $FAIL -eq 0 ] && echo "ALL GREEN ✅" || echo "FAILURES ❌"
exit $FAIL