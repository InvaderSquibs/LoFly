#!/usr/bin/env bash
# Start FS-Avatar webhook (if needed) and run a real Battlesnake engine game.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${FS_AVATAR_PORT:-8001}"
URL="http://127.0.0.1:${PORT}"
NAME="${FS_AVATAR_NAME:-Walton-LoFly-v0.1}"

# Detached start — plain `python3 server.py &` dies when Cursor agent shells exit.
bash "$ROOT/ensure_up.sh"

if ! command -v battlesnake >/dev/null 2>&1; then
  echo "Installing Battlesnake CLI via go install…"
  go install github.com/BattlesnakeOfficial/rules/cli/battlesnake@latest
  export PATH="$(go env GOPATH)/bin:$PATH"
fi

echo "Playing solo as $NAME → $URL"
exec battlesnake play -W 11 -H 11 --name "$NAME" --url "$URL" -g solo -d 120 -v "$@"
