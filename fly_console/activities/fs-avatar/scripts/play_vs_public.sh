#!/bin/bash
# Start public-snake proxy (curl upstream) and play Walton locally against it.
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Users/zach.walton/go/bin:$PATH"
ROOT="/Users/zach.walton/Dev/sandbox/fly-brain/fly_console/activities/fs-avatar"
REMOTE="${REMOTE_SNAKE_URL:-https://my-battlesnake.fly.dev}"
PORT="${PROXY_PORT:-19001}"
OUT="$ROOT/logs/public-vs-community.json"
LOG="$ROOT/logs/public-vs-community.play.log"
PLOG="$ROOT/logs/proxy-public.log"

pkill -f "PROXY_PORT=$PORT|curl_proxy_snake.sh" 2>/dev/null || true
sleep 0.2

# Allowlist tip + upstream health
curl -sS -m 8 "$REMOTE/" >/dev/null

REMOTE_SNAKE_URL="$REMOTE" PROXY_PORT="$PORT" \
  nohup bash "$ROOT/scripts/curl_proxy_snake.sh" >"$PLOG" 2>&1 &
echo "proxy_pid=$!"

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS -m 2 "http://127.0.0.1:$PORT/" | grep -q apiversion; then
    break
  fi
  sleep 0.3
done
echo -n "proxy_meta="; curl -sS -m 5 "http://127.0.0.1:$PORT/"; echo

# Ensure Walton local is up
curl -sS -m 2 "http://127.0.0.1:8001/" | grep -q apiversion

battlesnake play -W 11 -H 11 \
  --name "Walton-LoFly" --url "http://127.0.0.1:8001/" \
  --name "community-public" --url "http://127.0.0.1:$PORT/" \
  -g standard -t 500 \
  --output "$OUT" \
  --browser >"$LOG" 2>&1
echo "exit=$?"
tail -40 "$LOG"
wc -c "$OUT"
