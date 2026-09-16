# Consecutive-win ladder for FS-Avatar

Fixed game shape: **11×11 standard · Walton + 3 bots** (Hungry / Scared / Hippo),
same layout as the first custom game. Escalate by **upping the bot dial packs**,
not changing opponent count.

Rungs: soft → beginner → balanced → hungry-hard → aggressive.

## Quick start

```bash
cd fly_console/activities/fs-avatar
bash ensure_up.sh          # Walton :8001 + bots :8002/:8003/:8004
python3 scripts/ladder.py status
python3 scripts/ladder.py cycle --max-tiers 2
```

## Commands

| Command | What it does |
| --- | --- |
| `climb` | Play bot packs upward until loss; store seed + bot dials under `ladder/runs/` |
| `evaluate` | Read the streak + loss; write candidate dials to `ladder/dials/cand-*.json` |
| `replay` | Restart Walton with candidate dials; replay same seeds + same bot packs |
| `promote` | If replay streak > `best_streak`, copy candidate → `dials/leader.json` |
| `cycle` | climb → evaluate → replay → promote (when improved) |
| `loop` | Repeat `cycle` until Ctrl-C (or `--cycles N`) |
| `export-wins` | Write / refresh `ladder/win_track.json` + `.csv` |
| `status` | Ladder state + live `/dev/status` dials |

## Win track

After each climb (and replay), consecutive wins are exported to:

- `ladder/win_track.json` — latest + best streak snapshot
- `ladder/win_track.csv` — flat rows for the latest track
- `ladder/runs/<climb-id>/win_track.{json,csv}` — per-climb copy

Each win row links `game_id` → full transcript in `logs/<game_id>.json`.

After a **promote**, deploy the new leader to Replit:

```bash
bash scripts/deploy_replit.sh
# then on Replit: Git → Pull → Republish, wake https://walton-lo-fly-v-01--Squibs.replit.app/
```

## Layout

```
ladder/
  state.json              # leader id, best_streak, phase
  tiers.json              # 3-bot rungs (bot_pack + dial paths)
  dials/leader.json       # current champion knobs
  dials/bots/*.json       # Hungry/Scared/Hippo dial packs per rung
  dials/cand-*.json       # proposed fly versions
  runs/<climb-id>/        # manifest + evaluate + replay + win_track
```

Dials are loaded by `server.py` via `FS_AVATAR_DIALS`.
Console policy can override with `window.FsAvatarDials`.
