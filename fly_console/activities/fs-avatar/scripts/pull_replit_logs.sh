#!/usr/bin/env bash
# Pull game transcripts from the live Replit fly (source of truth for Battlesnake.com games).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${FS_AVATAR_PUBLIC:-https://walton-lo-fly-v-01--Squibs.replit.app}"
DEST="${ROOT}/logs/replit"
LIMIT="${1:-30}"
mkdir -p "$DEST"

echo "status: $(curl -sf -m 15 "$API/dev/status" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("dials_id"), "games", d.get("games_logged"))')"
curl -sf -m 30 "$API/dev/games?limit=$LIMIT" -o "$DEST/_index.json"
python3 - "$API" "$DEST" <<'PY'
import json, sys, urllib.request
from pathlib import Path
api, dest = sys.argv[1], Path(sys.argv[2])
index = json.loads((dest / "_index.json").read_text())
games = index.get("games") or []
print(f"index {len(games)} games → {dest}")
for g in games:
    gid = g.get("game_id")
    if not gid:
        continue
    path = dest / f"{gid}.json"
    url = f"{api}/dev/game/{gid}"
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            data = resp.read()
        path.write_bytes(data)
        meta = json.loads(data)
        print(
            f"  saved {gid[:8]}… outcome={meta.get('outcome')} "
            f"turns={len(meta.get('turns') or [])} dials={meta.get('dials_id')}"
        )
    except Exception as e:
        print(f"  FAIL {gid}: {e}")
print("done")
PY
