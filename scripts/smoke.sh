#!/usr/bin/env bash
# 冒烟测试：启动服务并验证核心 API
# 用法：bash scripts/smoke.sh
set -euo pipefail

PORT="${PORT:-3210}"
DB="$(mktemp -d)/smoke.sqlite"
export PORT DB_PATH="$DB"

node server.js > /tmp/ads-smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 3

pass=0; fail=0
check() { # $1 描述 $2 curl 参数...
  local desc="$1"; shift
  if out=$(curl -sf "$@" 2>/dev/null); then
    echo "✅ $desc"; pass=$((pass+1))
  else
    echo "❌ $desc"; fail=$((fail+1))
  fi
}

BASE="http://localhost:$PORT"
check "health（含 dailyCount/rev）" "$BASE/api/health"
check "空数据读取" "$BASE/api/ads"
check "选项读取" "$BASE/api/options"

# 写入一条数据（含 rev=0）
REV=$(curl -s "$BASE/api/ads" | python3 -c "import json,sys; print(json.load(sys.stdin)['rev'])")
curl -sf -X PUT "$BASE/api/ads" -H 'Content-Type: application/json' \
  -d "{\"rev\":$REV,\"ads\":[{\"no\":\"AD-001\",\"product\":\"测试产品\",\"market\":\"德国\",\"budget\":100,\"status\":\"测试中\",\"createdAt\":\"2026-10-02\",\"daily\":[{\"date\":\"2026-10-02\",\"spend\":10,\"orders\":2,\"revenue\":50}]}]}" > /dev/null \
  && echo "✅ 写入数据（乐观锁 rev=$REV）" && pass=$((pass+1)) || { echo "❌ 写入数据"; fail=$((fail+1)); }

# 用旧 rev 再次写入，应 409
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/ads" -H 'Content-Type: application/json' \
  -d "{\"rev\":$REV,\"ads\":[]}")
if [ "$CODE" = "409" ]; then echo "✅ 旧版本写入被拒绝（409）"; pass=$((pass+1)); else echo "❌ 409 冲突检测（got $CODE）"; fail=$((fail+1)); fi

check "统计接口" "$BASE/api/stats"
check "备份列表" "$BASE/api/backups"
curl -sf -X POST "$BASE/api/backups" > /dev/null && echo "✅ 手动备份" && pass=$((pass+1)) || { echo "❌ 手动备份"; fail=$((fail+1)); }
BID=$(curl -s "$BASE/api/backups" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
curl -sf -X POST "$BASE/api/backups/$BID/restore" > /dev/null && echo "✅ 备份恢复" && pass=$((pass+1)) || { echo "❌ 备份恢复"; fail=$((fail+1)); }
check "选项新增" -X POST "$BASE/api/options" -H 'Content-Type: application/json' -d '{"kind":"product","value":"冒烟测试产品"}'
curl -sf -X DELETE "$BASE/api/options/product/%E5%86%92%E7%83%9F%E6%B5%8B%E8%AF%95%E4%BA%A7%E5%93%81" > /dev/null \
  && echo "✅ 选项删除" && pass=$((pass+1)) || { echo "❌ 选项删除"; fail=$((fail+1)); }

# 访问密码
APP_PASSWORD=secret123 PORT=$((PORT+1)) DB_PATH="$(mktemp -d)/auth.sqlite" node server.js > /tmp/ads-smoke-auth.log 2>&1 &
SRV2=$!
sleep 3
ABASE="http://localhost:$((PORT+1))"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ABASE/api/ads")
[ "$CODE" = "401" ] && echo "✅ 未登录被拒绝（401）" && pass=$((pass+1)) || { echo "❌ 401 鉴权（got $CODE）"; fail=$((fail+1)); }
TOKEN=$(curl -s -X POST "$ABASE/api/login" -H 'Content-Type: application/json' -d '{"password":"secret123"}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))")
[ -n "$TOKEN" ] && curl -sf -H "x-app-token: $TOKEN" "$ABASE/api/ads" > /dev/null \
  && echo "✅ 登录后访问正常" && pass=$((pass+1)) || { echo "❌ 登录流程"; fail=$((fail+1)); }
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$ABASE/api/login" -H 'Content-Type: application/json' -d '{"password":"wrong"}')
[ "$CODE" = "401" ] && echo "✅ 错误密码被拒绝" && pass=$((pass+1)) || { echo "❌ 错误密码（got $CODE）"; fail=$((fail+1)); }
kill $SRV2 2>/dev/null

echo ""
echo "通过 $pass，失败 $fail"
[ "$fail" = "0" ]
