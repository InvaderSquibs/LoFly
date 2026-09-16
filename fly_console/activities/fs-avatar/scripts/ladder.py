#!/usr/bin/env python3
"""
Consecutive-win ladder for FS-Avatar.

Cycle:
  1. climb   — escalate bot tiers until a loss; store each battle (seed + opponents)
  2. evaluate — inspect the win streak + loss; propose candidate dials
  3. replay  — redeploy candidate dials; replay the same battles
  4. promote — if replay streak > best_streak, promote candidate to leader

Usage:
  python3 scripts/ladder.py status
  python3 scripts/ladder.py climb [--max-tiers N] [--from-tier I]
  python3 scripts/ladder.py evaluate
  python3 scripts/ladder.py replay
  python3 scripts/ladder.py promote
  python3 scripts/ladder.py cycle [--max-tiers N]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]
LADDER = ROOT / "ladder"
STATE_PATH = LADDER / "state.json"
TIERS_PATH = LADDER / "tiers.json"
DIALS_DIR = LADDER / "dials"
RUNS_DIR = LADDER / "runs"
LEADER_PATH = DIALS_DIR / "leader.json"
WIN_TRACK_JSON = LADDER / "win_track.json"
WIN_TRACK_CSV = LADDER / "win_track.csv"
API = os.environ.get("FS_AVATAR_API", "http://127.0.0.1:8001")
YOU_NAME = os.environ.get("FS_AVATAR_NAME", "Walton-LoFly-v0.1")

sys.path.insert(0, str(ROOT))
import dials as dials_mod  # noqa: E402
import game_log  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _load_json(path: Path, default: Any = None) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def load_state() -> Dict[str, Any]:
    return _load_json(
        STATE_PATH,
        {
            "leader_dials_id": "leader",
            "leader_dials_path": "dials/leader.json",
            "best_streak": 0,
            "current_streak": 0,
            "current_tier_index": 0,
            "phase": "idle",
            "active_climb_id": None,
            "candidate_id": None,
            "history": [],
        },
    )


def save_state(state: Dict[str, Any]) -> None:
    _save_json(STATE_PATH, state)


def load_tiers() -> List[Dict[str, Any]]:
    data = _load_json(TIERS_PATH, {"tiers": []})
    return list(data.get("tiers") or [])


def find_cli() -> str:
    for cand in (
        os.environ.get("BATTLESNAKE_CLI"),
        shutil.which("battlesnake"),
        str(Path.home() / "go" / "bin" / "battlesnake"),
    ):
        if cand and Path(cand).is_file():
            return cand
    raise SystemExit("battlesnake CLI not found — install with go install …/battlesnake@latest")


def api_get(path: str, timeout: float = 5.0) -> Dict[str, Any]:
    req = urllib.request.Request(f"{API}{path}", method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_api(timeout: float = 20.0) -> Dict[str, Any]:
    deadline = time.time() + timeout
    last_err: Optional[Exception] = None
    while time.time() < deadline:
        try:
            st = api_get("/dev/status")
            if st.get("ok"):
                return st
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
        time.sleep(0.25)
    raise SystemExit(f"API not ready at {API}: {last_err}")


def ensure_servers(
    dials_path: Optional[Path] = None,
    restart_you: bool = False,
    opponents: Optional[List[Dict[str, Any]]] = None,
    restart_rivals: bool = False,
) -> None:
    """Bring up Walton + 3 bots; optionally swap dial packs on you / rivals."""
    env = os.environ.copy()
    path = dials_path or LEADER_PATH
    env["FS_AVATAR_DIALS"] = str(path.resolve())
    env["FS_AVATAR_RIVALS"] = "1"

    if opponents:
        for o in opponents:
            url = str(o.get("url") or "")
            dials_rel = o.get("dials")
            if not dials_rel:
                continue
            # url like http://127.0.0.1:8002
            try:
                port = url.rsplit(":", 1)[-1].rstrip("/")
                int(port)
            except ValueError:
                continue
            dials_file = (LADDER / dials_rel).resolve() if not Path(dials_rel).is_absolute() else Path(dials_rel)
            env[f"FS_RIVAL_{port}_DIALS"] = str(dials_file)
            if o.get("name"):
                env[f"FS_RIVAL_{port}_NAME"] = str(o["name"])

    ports_to_kill: List[int] = []
    if restart_you:
        ports_to_kill.append(8001)
    if restart_rivals:
        ports_to_kill.extend([8002, 8003, 8004])
    for port in ports_to_kill:
        pidfile = Path(f"/tmp/fs-{port}.pid")
        if pidfile.is_file():
            try:
                os.kill(int(pidfile.read_text().strip()), 9)
            except (OSError, ValueError):
                pass
        subprocess.run(
            ["bash", "-lc", f"lsof -tiTCP:{port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true"],
            check=False,
        )
    if ports_to_kill:
        time.sleep(0.35)

    subprocess.run(
        ["bash", str(ROOT / "ensure_up.sh")],
        cwd=str(ROOT),
        env=env,
        check=False,
    )
    wait_api()
    # soft-wait rivals
    for port in (8002, 8003, 8004):
        for _ in range(20):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.15)


def play_battle(
    tier: Dict[str, Any],
    seed: int,
    dials_path: Path,
    label: str,
) -> Dict[str, Any]:
    """Run one battlesnake play; return battle record with outcome."""
    cli = find_cli()
    opponents = list(tier.get("opponents") or [])
    ensure_servers(
        dials_path=dials_path,
        restart_you=False,
        opponents=opponents,
        restart_rivals=True,
    )
    wait_api()

    before = set()
    for g in game_log.list_games(30):
        if g.get("game_id"):
            before.add(g["game_id"])

    width = int(tier.get("width") or 11)
    height = int(tier.get("height") or 11)
    gametype = str(tier.get("gametype") or "standard")
    delay = int(tier.get("delay") or 8)
    if opponents and gametype == "solo":
        gametype = "standard"

    cmd = [
        cli,
        "play",
        "-W",
        str(width),
        "-H",
        str(height),
        "--name",
        YOU_NAME,
        "--url",
        API,
        "-g",
        gametype,
        "-d",
        str(delay),
        "--seed",
        str(seed),
    ]
    for o in opponents:
        cmd.extend(["--name", str(o["name"]), "--url", str(o["url"])])

    pack = tier.get("bot_pack") or ""
    print(f"  ▶ {label} tier={tier.get('id')} pack={pack} seed={seed} opps={len(opponents)}")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    # wait for /end to flush log
    game_id = None
    outcome = None
    analysis: Dict[str, Any] = {}
    for _ in range(40):
        latest = game_log.load_game("latest")
        if latest and latest.get("game_id") and latest["game_id"] not in before:
            game_id = latest["game_id"]
            outcome = latest.get("outcome")
            analysis = latest.get("analysis") or game_log.analyze_game(latest)
            break
        time.sleep(0.15)

    if not game_id:
        # fallback: newest file
        games = game_log.list_games(1)
        if games:
            game_id = games[0].get("game_id")
            outcome = games[0].get("outcome")
            g = game_log.load_game(game_id) if game_id else None
            if g:
                analysis = g.get("analysis") or game_log.analyze_game(g)

    won = outcome == "win"
    battle = {
        "tier_id": tier.get("id"),
        "tier_label": tier.get("label"),
        "bot_pack": pack,
        "seed": seed,
        "width": width,
        "height": height,
        "gametype": gametype,
        "delay": delay,
        "opponents": opponents,
        "game_id": game_id,
        "outcome": outcome,
        "won": won,
        "exit_code": proc.returncode,
        "analysis": {
            "n_turns": analysis.get("n_turns"),
            "panic_turns": analysis.get("panic_turns"),
            "food_eaten_est": analysis.get("food_eaten_est"),
            "near_miss_turns": analysis.get("near_miss_turns"),
            "length_peak": analysis.get("length_peak"),
        },
        "log_tail": (proc.stdout or "")[-800:],
    }
    mark = "WIN" if won else f"LOSS ({outcome})"
    print(f"    → {mark} game={game_id} turns={battle['analysis'].get('n_turns')}")
    return battle


def write_win_track(manifest: Dict[str, Any], source: str = "climb") -> Dict[str, Any]:
    """Export consecutive-win track for a climb (per-run + rolling ladder files)."""
    climb_id = manifest.get("climb_id") or "unknown"
    wins = list(manifest.get("win_battles") or [])
    loss = manifest.get("loss")
    streak = int(manifest.get("streak") or len(wins))
    state = load_state()

    rows: List[Dict[str, Any]] = []
    for i, b in enumerate(wins, start=1):
        a = b.get("analysis") or {}
        rows.append(
            {
                "climb_id": climb_id,
                "source": source,
                "streak_index": i,
                "role": "win",
                "game_id": b.get("game_id"),
                "tier_id": b.get("tier_id"),
                "tier_label": b.get("tier_label"),
                "seed": b.get("seed"),
                "outcome": b.get("outcome"),
                "opponents": ",".join(
                    o.get("name") or "" for o in (b.get("opponents") or [])
                ),
                "width": b.get("width"),
                "height": b.get("height"),
                "turns": a.get("n_turns"),
                "food_eaten_est": a.get("food_eaten_est"),
                "panic_turns": a.get("panic_turns"),
                "near_miss_turns": a.get("near_miss_turns"),
                "length_peak": a.get("length_peak"),
            }
        )
    if loss:
        a = loss.get("analysis") or {}
        rows.append(
            {
                "climb_id": climb_id,
                "source": source,
                "streak_index": streak + 1,
                "role": "loss",
                "game_id": loss.get("game_id"),
                "tier_id": loss.get("tier_id"),
                "tier_label": loss.get("tier_label"),
                "seed": loss.get("seed"),
                "outcome": loss.get("outcome"),
                "opponents": ",".join(
                    o.get("name") or "" for o in (loss.get("opponents") or [])
                ),
                "width": loss.get("width"),
                "height": loss.get("height"),
                "turns": a.get("n_turns"),
                "food_eaten_est": a.get("food_eaten_est"),
                "panic_turns": a.get("panic_turns"),
                "near_miss_turns": a.get("near_miss_turns"),
                "length_peak": a.get("length_peak"),
            }
        )

    track = {
        "updated_at": _now(),
        "climb_id": climb_id,
        "source": source,
        "leader_dials_id": manifest.get("leader_dials_id") or state.get("leader_dials_id"),
        "streak": streak,
        "best_streak": int(state.get("best_streak") or 0),
        "phase": manifest.get("phase"),
        "win_game_ids": [b.get("game_id") for b in wins],
        "loss_game_id": (loss or {}).get("game_id"),
        "wins": [
            {
                "streak_index": i,
                "game_id": b.get("game_id"),
                "tier_id": b.get("tier_id"),
                "seed": b.get("seed"),
                "opponents": b.get("opponents") or [],
                "analysis": b.get("analysis") or {},
                "log_file": f"logs/{b.get('game_id')}.json" if b.get("game_id") else None,
            }
            for i, b in enumerate(wins, start=1)
        ],
        "loss": (
            {
                "game_id": loss.get("game_id"),
                "tier_id": loss.get("tier_id"),
                "seed": loss.get("seed"),
                "opponents": loss.get("opponents") or [],
                "outcome": loss.get("outcome"),
                "analysis": loss.get("analysis") or {},
                "log_file": f"logs/{loss.get('game_id')}.json" if loss.get("game_id") else None,
            }
            if loss
            else None
        ),
        "rows": rows,
    }

    run_dir = RUNS_DIR / climb_id
    run_dir.mkdir(parents=True, exist_ok=True)
    _save_json(run_dir / "win_track.json", track)
    _write_win_track_csv(run_dir / "win_track.csv", rows)

    # Rolling ladder-level track (latest climb + keep best streak snapshot)
    rolling = _load_json(
        WIN_TRACK_JSON,
        {"updated_at": None, "best_streak": 0, "latest": None, "best": None, "history": []},
    )
    rolling["updated_at"] = track["updated_at"]
    rolling["latest"] = track
    rolling["best_streak"] = max(int(rolling.get("best_streak") or 0), streak, int(state.get("best_streak") or 0))
    if streak >= int((rolling.get("best") or {}).get("streak") or 0):
        rolling["best"] = track
    hist = list(rolling.get("history") or [])
    hist.append(
        {
            "at": track["updated_at"],
            "climb_id": climb_id,
            "source": source,
            "streak": streak,
            "win_game_ids": track["win_game_ids"],
            "loss_game_id": track["loss_game_id"],
        }
    )
    rolling["history"] = hist[-100:]
    _save_json(WIN_TRACK_JSON, rolling)
    _write_win_track_csv(WIN_TRACK_CSV, rows)

    print(f"  win track → {run_dir / 'win_track.json'}  (+ {WIN_TRACK_JSON.name})")
    return track


def _write_win_track_csv(path: Path, rows: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "climb_id",
        "source",
        "streak_index",
        "role",
        "game_id",
        "tier_id",
        "tier_label",
        "seed",
        "outcome",
        "opponents",
        "width",
        "height",
        "turns",
        "food_eaten_est",
        "panic_turns",
        "near_miss_turns",
        "length_peak",
    ]
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow(row)


def cmd_status(_: argparse.Namespace) -> None:
    state = load_state()
    tiers = load_tiers()
    try:
        api = api_get("/dev/status")
    except Exception as e:  # noqa: BLE001
        api = {"ok": False, "error": str(e)}
    track = _load_json(WIN_TRACK_JSON, {})
    print(
        json.dumps(
            {
                "state": state,
                "tiers": [t.get("id") for t in tiers],
                "api": api,
                "win_track": {
                    "best_streak": (track or {}).get("best_streak"),
                    "latest_streak": ((track or {}).get("latest") or {}).get("streak"),
                    "latest_climb": ((track or {}).get("latest") or {}).get("climb_id"),
                    "path": str(WIN_TRACK_JSON),
                    "csv": str(WIN_TRACK_CSV),
                },
            },
            indent=2,
        )
    )


def cmd_export_wins(args: argparse.Namespace) -> None:
    """Refresh win_track from a climb manifest (default: active climb)."""
    state = load_state()
    climb_id = args.climb_id or state.get("active_climb_id")
    if not climb_id:
        raise SystemExit("no climb_id — run climb first")
    manifest = _load_json(RUNS_DIR / climb_id / "manifest.json")
    if not manifest:
        raise SystemExit(f"no manifest for {climb_id}")
    track = write_win_track(manifest, source=args.source or "export")
    print(json.dumps({"climb_id": climb_id, "streak": track["streak"], "wins": track["win_game_ids"]}, indent=2))


def cmd_climb(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state()
    tiers = load_tiers()
    if not tiers:
        raise SystemExit("no tiers in ladder/tiers.json")

    first = tiers[0]
    ensure_servers(
        dials_path=LEADER_PATH,
        restart_you=True,
        opponents=list(first.get("opponents") or []),
        restart_rivals=True,
    )
    climb_id = f"climb-{_now()}"
    run_dir = RUNS_DIR / climb_id
    run_dir.mkdir(parents=True, exist_ok=True)

    start_i = int(args.from_tier if args.from_tier is not None else state.get("current_tier_index") or 0)
    start_i = max(0, min(start_i, len(tiers) - 1))
    max_tiers = int(args.max_tiers) if args.max_tiers else len(tiers)
    end_i = min(len(tiers), start_i + max_tiers)

    battles: List[Dict[str, Any]] = []
    streak = 0
    loss_battle: Optional[Dict[str, Any]] = None

    for i in range(start_i, end_i):
        tier = tiers[i]
        seed = random.randint(1, 2**31 - 1)
        battle = play_battle(tier, seed, LEADER_PATH, f"climb[{i}]")
        battle["tier_index"] = i
        battles.append(battle)
        _save_json(run_dir / "manifest.json", {
            "climb_id": climb_id,
            "leader_dials_id": state.get("leader_dials_id"),
            "started_at": climb_id,
            "battles": battles,
        })
        if battle["won"]:
            streak += 1
            state["current_tier_index"] = min(i + 1, len(tiers) - 1)
            state["current_streak"] = streak
            save_state(state)
        else:
            loss_battle = battle
            break

    manifest = {
        "climb_id": climb_id,
        "phase": "lost" if loss_battle else "cleared",
        "leader_dials_id": state.get("leader_dials_id"),
        "leader_dials_path": str(LEADER_PATH),
        "streak": streak,
        "best_streak_at_start": state.get("best_streak", 0),
        "start_tier_index": start_i,
        "battles": battles,
        "loss": loss_battle,
        "win_battles": [b for b in battles if b.get("won")],
    }
    _save_json(run_dir / "manifest.json", manifest)
    write_win_track(manifest, source="climb")

    state["phase"] = "evaluate" if loss_battle or streak > 0 else "idle"
    state["active_climb_id"] = climb_id
    state["current_streak"] = streak
    if streak > int(state.get("best_streak") or 0):
        # climbing with current leader already beat prior best — record it
        state["best_streak"] = streak
    save_state(state)

    print(f"\nClimb {climb_id}: streak={streak} phase={manifest['phase']}")
    print(f"  stored → {run_dir / 'manifest.json'}")
    return manifest


def propose_dials(manifest: Dict[str, Any], leader: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """Heuristic dial tweaks from consecutive wins + the loss that stopped the climb."""
    candidate = dict(leader)
    notes: List[str] = []
    loss = manifest.get("loss") or {}
    wins = manifest.get("win_battles") or []
    analysis = (loss.get("analysis") or {}) if loss else {}
    panic = analysis.get("panic_turns") or 0
    turns = max(1, analysis.get("n_turns") or 1)
    food = analysis.get("food_eaten_est") or 0
    near = analysis.get("near_miss_turns") or 0

    # Base: nudge toward taking exclusive fruit under soft danger
    if panic / turns > 0.4:
        candidate["panic_food_gate"] = round(min(0.75, float(leader.get("panic_food_gate", 0.4)) + 0.1), 3)
        candidate["smell_panic_dampen"] = round(
            min(0.7, float(leader.get("smell_panic_dampen", 0.35)) + 0.1), 3
        )
        notes.append("high panic ratio → ease food gate / scent dampen in panic")
    if food < 2 and turns > 8:
        candidate["fruit_hard_danger"] = round(
            max(0.5, float(leader.get("fruit_hard_danger", 1.0)) - 0.25), 3
        )
        candidate["fruit_soft_scale"] = round(
            min(0.75, float(leader.get("fruit_soft_scale", 0.4)) + 0.15), 3
        )
        candidate["exclusive_near_boost"] = round(
            min(1.4, float(leader.get("exclusive_near_boost", 1.15)) + 0.1), 3
        )
        notes.append("low food on loss → softer fruit veto + exclusive near boost")
    if near > 3 or (loss and not wins):
        candidate["panic_safety_thresh"] = round(
            min(0.4, float(leader.get("panic_safety_thresh", 0.25)) + 0.05), 3
        )
        notes.append("near-miss / early loss → earlier panic escape")
    if wins and food >= 2:
        # wins ate ok — try slightly more race aggression for next tier
        candidate["race_food_gate"] = round(
            min(1.6, float(leader.get("race_food_gate", 1.35)) + 0.05), 3
        )
        notes.append("wins had food → slight race gate bump")

    # Always stamp identity
    cid = f"cand-{manifest.get('climb_id', _now())}"
    candidate["id"] = cid
    candidate["parent_id"] = leader.get("id")
    candidate["wiring"] = leader.get("wiring") or "retina_sectors_v1_orchard"
    candidate["notes"] = "; ".join(notes) if notes else "small exploratory nudge"
    candidate["proposed_from_climb"] = manifest.get("climb_id")
    candidate["proposed_at"] = _now()
    return candidate, notes


def cmd_evaluate(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state()
    climb_id = args.climb_id or state.get("active_climb_id")
    if not climb_id:
        raise SystemExit("no active climb — run climb first")
    manifest = _load_json(RUNS_DIR / climb_id / "manifest.json")
    if not manifest:
        raise SystemExit(f"manifest missing for {climb_id}")

    leader = _load_json(LEADER_PATH) or dials_mod.load_dials(force=True)
    candidate, notes = propose_dials(manifest, leader)
    cand_path = DIALS_DIR / f"{candidate['id']}.json"
    dials_mod.save_dials(cand_path, candidate)

    eval_doc = {
        "climb_id": climb_id,
        "streak": manifest.get("streak"),
        "best_streak": state.get("best_streak"),
        "win_game_ids": [b.get("game_id") for b in (manifest.get("win_battles") or [])],
        "loss_game_id": (manifest.get("loss") or {}).get("game_id"),
        "notes": notes,
        "candidate_path": str(cand_path),
        "candidate_id": candidate["id"],
        "leader_id": leader.get("id"),
    }
    _save_json(RUNS_DIR / climb_id / "evaluate.json", eval_doc)
    state["phase"] = "replay"
    state["candidate_id"] = candidate["id"]
    save_state(state)
    print(json.dumps(eval_doc, indent=2))
    return eval_doc


def cmd_replay(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state()
    climb_id = args.climb_id or state.get("active_climb_id")
    if not climb_id:
        raise SystemExit("no active climb")
    run_dir = RUNS_DIR / climb_id
    manifest = _load_json(run_dir / "manifest.json")
    if not manifest:
        raise SystemExit(f"missing manifest {climb_id}")

    cand_id = args.candidate or state.get("candidate_id")
    if not cand_id:
        raise SystemExit("no candidate — run evaluate first")
    cand_path = DIALS_DIR / f"{cand_id}.json"
    if not cand_path.is_file():
        raise SystemExit(f"candidate dials not found: {cand_path}")

    # Replay the win streak battles + the loss battle (same seeds/opponents)
    to_replay = list(manifest.get("win_battles") or [])
    if manifest.get("loss"):
        to_replay = to_replay + [manifest["loss"]]
    if not to_replay:
        to_replay = list(manifest.get("battles") or [])

    ensure_servers(dials_path=cand_path, restart_you=True, restart_rivals=False)
    results: List[Dict[str, Any]] = []
    streak = 0
    for i, orig in enumerate(to_replay):
        tier = {
            "id": orig.get("tier_id"),
            "label": orig.get("tier_label"),
            "bot_pack": orig.get("bot_pack"),
            "width": orig.get("width"),
            "height": orig.get("height"),
            "gametype": orig.get("gametype"),
            "delay": orig.get("delay"),
            "opponents": orig.get("opponents") or [],
        }
        battle = play_battle(tier, int(orig["seed"]), cand_path, f"replay[{i}]")
        battle["original_game_id"] = orig.get("game_id")
        battle["original_outcome"] = orig.get("outcome")
        results.append(battle)
        if battle["won"]:
            streak += 1
        else:
            break

    replay_doc = {
        "climb_id": climb_id,
        "candidate_id": cand_id,
        "candidate_path": str(cand_path),
        "replay_streak": streak,
        "prior_streak": manifest.get("streak"),
        "best_streak": state.get("best_streak"),
        "improved": streak > int(state.get("best_streak") or 0),
        "battles": results,
    }
    _save_json(run_dir / "replay.json", replay_doc)
    # Export replay streak as a win track variant for comparison
    write_win_track(
        {
            "climb_id": climb_id,
            "phase": "replay",
            "leader_dials_id": cand_id,
            "streak": streak,
            "win_battles": [b for b in results if b.get("won")],
            "loss": next((b for b in results if not b.get("won")), None),
        },
        source="replay",
    )
    state["phase"] = "promote" if replay_doc["improved"] else "idle"
    state["last_replay_streak"] = streak
    save_state(state)
    if not replay_doc["improved"]:
        # put champion back on the wire
        ensure_servers(dials_path=LEADER_PATH, restart_you=True)
    print(json.dumps({k: replay_doc[k] for k in ("candidate_id", "replay_streak", "prior_streak", "best_streak", "improved")}, indent=2))
    return replay_doc


def cmd_promote(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state()
    climb_id = args.climb_id or state.get("active_climb_id")
    if not climb_id:
        raise SystemExit("no active climb")
    replay = _load_json(RUNS_DIR / climb_id / "replay.json")
    if not replay:
        raise SystemExit("no replay.json — run replay first")
    if not replay.get("improved") and not args.force:
        raise SystemExit(
            f"candidate streak {replay.get('replay_streak')} did not beat best {replay.get('best_streak')} "
            "(pass --force to promote anyway)"
        )

    cand_path = Path(replay["candidate_path"])
    candidate = _load_json(cand_path)
    # archive previous leader
    prev = _load_json(LEADER_PATH, {})
    archive = DIALS_DIR / f"archive-{prev.get('id', 'leader')}-{_now()}.json"
    if LEADER_PATH.is_file():
        shutil.copy2(LEADER_PATH, archive)

    new_leader = dict(candidate)
    new_leader["id"] = f"leader-{candidate.get('id', _now())}"
    new_leader["promoted_from"] = candidate.get("id")
    new_leader["promoted_at"] = _now()
    new_leader["promoted_streak"] = replay.get("replay_streak")
    dials_mod.save_dials(LEADER_PATH, new_leader)
    # also keep a named copy
    dials_mod.save_dials(DIALS_DIR / f"{new_leader['id']}.json", new_leader)

    ensure_servers(dials_path=LEADER_PATH, restart_you=True)

    state["leader_dials_id"] = new_leader["id"]
    state["leader_dials_path"] = "dials/leader.json"
    state["best_streak"] = int(replay.get("replay_streak") or 0)
    state["current_streak"] = 0
    state["current_tier_index"] = 0
    state["phase"] = "idle"
    state["candidate_id"] = None
    hist = list(state.get("history") or [])
    hist.append(
        {
            "at": _now(),
            "climb_id": climb_id,
            "leader_id": new_leader["id"],
            "streak": state["best_streak"],
            "archive": str(archive.name),
        }
    )
    state["history"] = hist[-50:]
    save_state(state)

    out = {
        "promoted": new_leader["id"],
        "best_streak": state["best_streak"],
        "archive": str(archive),
    }
    print(json.dumps(out, indent=2))
    return out


def cmd_cycle(args: argparse.Namespace) -> None:
    print("=== LADDER CYCLE: climb → evaluate → replay → promote? ===")
    cmd_climb(args)
    cmd_evaluate(argparse.Namespace(climb_id=None))
    replay = cmd_replay(argparse.Namespace(climb_id=None, candidate=None))
    if replay.get("improved"):
        cmd_promote(argparse.Namespace(climb_id=None, force=False))
        print("Promoted. Ready to climb again with new leader.")
    else:
        print("No promotion — leader keeps the crown. Tweak dials or climb again.")


def cmd_loop(args: argparse.Namespace) -> None:
    """Keep running cycles until interrupted."""
    n = int(args.cycles or 0)
    i = 0
    while True:
        i += 1
        print(f"\n######## LOOP CYCLE {i} ########")
        cmd_cycle(args)
        if n and i >= n:
            break
        # reset tier pointer so next climb starts from bottom with current leader
        state = load_state()
        state["current_tier_index"] = 0
        save_state(state)
        time.sleep(float(args.pause or 1.0))


def main() -> None:
    p = argparse.ArgumentParser(description="FS-Avatar consecutive-win ladder")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Show ladder state + API dials")

    pc = sub.add_parser("climb", help="Escalate tiers until loss")
    pc.add_argument("--max-tiers", type=int, default=None)
    pc.add_argument("--from-tier", type=int, default=None)

    pe = sub.add_parser("evaluate", help="Propose candidate dials from last climb")
    pe.add_argument("--climb-id", default=None)

    pr = sub.add_parser("replay", help="Replay stored battles with candidate dials")
    pr.add_argument("--climb-id", default=None)
    pr.add_argument("--candidate", default=None)

    pp = sub.add_parser("promote", help="Promote candidate if it beat best streak")
    pp.add_argument("--climb-id", default=None)
    pp.add_argument("--force", action="store_true")

    py = sub.add_parser("cycle", help="climb → evaluate → replay → promote")
    py.add_argument("--max-tiers", type=int, default=None)
    py.add_argument("--from-tier", type=int, default=None)

    pl = sub.add_parser("loop", help="Repeat cycle until Ctrl-C (or --cycles N)")
    pl.add_argument("--max-tiers", type=int, default=None)
    pl.add_argument("--from-tier", type=int, default=None)
    pl.add_argument("--cycles", type=int, default=0, help="0 = forever")
    pl.add_argument("--pause", type=float, default=1.0)

    px = sub.add_parser("export-wins", help="Write win_track.json/csv from a climb")
    px.add_argument("--climb-id", default=None)
    px.add_argument("--source", default="export")

    args = p.parse_args()
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    DIALS_DIR.mkdir(parents=True, exist_ok=True)

    if args.cmd == "status":
        cmd_status(args)
    elif args.cmd == "climb":
        cmd_climb(args)
    elif args.cmd == "evaluate":
        cmd_evaluate(args)
    elif args.cmd == "replay":
        cmd_replay(args)
    elif args.cmd == "promote":
        cmd_promote(args)
    elif args.cmd == "cycle":
        cmd_cycle(args)
    elif args.cmd == "loop":
        cmd_loop(args)
    elif args.cmd == "export-wins":
        cmd_export_wins(args)
    else:
        p.error(f"unknown cmd {args.cmd}")


if __name__ == "__main__":
    main()
