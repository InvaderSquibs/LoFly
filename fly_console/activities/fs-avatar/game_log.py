"""
Persistent Battlesnake game transcripts + risk/reward analysis for neuron mapping.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

LOG_DIR = Path(__file__).resolve().parent / "logs"
_lock = threading.Lock()
_active: Dict[str, Any] = {}  # game_id -> in-memory accumulator


def _ensure_dir() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def _path_for(game_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in game_id)[:80]
    return LOG_DIR / f"{safe}.json"


def _summarize_board(req: Dict[str, Any]) -> Dict[str, Any]:
    board = req.get("board") or {}
    you = req.get("you") or {}
    snakes = board.get("snakes") or []
    return {
        "turn": req.get("turn"),
        "you_health": you.get("health"),
        "you_length": you.get("length"),
        "you_head": you.get("head"),
        "you_body": you.get("body"),
        "food": board.get("food") or [],
        "food_n": len(board.get("food") or []),
        "hazards": board.get("hazards") or [],
        "snakes": [
            {
                "id": s.get("id"),
                "name": s.get("name"),
                "health": s.get("health"),
                "length": s.get("length"),
                "head": s.get("head"),
                "body": s.get("body"),
            }
            for s in snakes
        ],
    }


def _model_meta() -> Dict[str, Any]:
    """Stamp dials / model id onto every logged game (Replit is source of truth)."""
    try:
        import dials as dials_mod

        d = dials_mod.load_dials()
        return {
            "dials_id": d.get("id"),
            "wiring": d.get("wiring"),
            "dials_path": str(dials_mod.dials_path() or "(defaults)"),
        }
    except Exception:
        return {"dials_id": None, "wiring": None, "dials_path": None}


def on_start(req: Dict[str, Any]) -> None:
    gid = ((req.get("game") or {}).get("id")) or f"unknown-{int(time.time())}"
    meta = _model_meta()
    with _lock:
        _active[gid] = {
            "game_id": gid,
            "started_at": time.time(),
            "ruleset": ((req.get("game") or {}).get("ruleset") or {}).get("name"),
            "source": (req.get("game") or {}).get("source"),
            "board_size": {
                "width": (req.get("board") or {}).get("width"),
                "height": (req.get("board") or {}).get("height"),
            },
            "you_name": (req.get("you") or {}).get("name"),
            "you_id": (req.get("you") or {}).get("id"),
            "dials_id": meta.get("dials_id"),
            "wiring": meta.get("wiring"),
            "dials_path": meta.get("dials_path"),
            "turns": [],
            "ended_at": None,
            "outcome": None,
        }


def on_move(req: Dict[str, Any], decision: Dict[str, Any]) -> None:
    gid = ((req.get("game") or {}).get("id")) or "unknown"
    entry = {
        "t": req.get("turn"),
        "move": decision.get("move"),
        "shout": decision.get("shout") or "",
        "signals": decision.get("signals") or {},
        "scored": decision.get("scored") or [],
        "board": _summarize_board(req),
    }
    with _lock:
        if gid not in _active:
            # Inline bootstrap — do NOT call on_start() while holding _lock (Lock is not reentrant).
            meta = _model_meta()
            _active[gid] = {
                "game_id": gid,
                "started_at": time.time(),
                "ruleset": ((req.get("game") or {}).get("ruleset") or {}).get("name"),
                "source": (req.get("game") or {}).get("source"),
                "board_size": {
                    "width": (req.get("board") or {}).get("width"),
                    "height": (req.get("board") or {}).get("height"),
                },
                "you_name": (req.get("you") or {}).get("name"),
                "you_id": (req.get("you") or {}).get("id"),
                "dials_id": meta.get("dials_id"),
                "wiring": meta.get("wiring"),
                "dials_path": meta.get("dials_path"),
                "turns": [],
                "ended_at": None,
                "outcome": None,
            }
        _active[gid]["turns"].append(entry)


def on_end(req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    gid = ((req.get("game") or {}).get("id")) or "unknown"
    with _lock:
        game = _active.pop(gid, None)
        if game is None:
            meta = _model_meta()
            game = {
                "game_id": gid,
                "started_at": time.time(),
                "turns": [],
                "you_name": (req.get("you") or {}).get("name"),
                "you_id": (req.get("you") or {}).get("id"),
                "dials_id": meta.get("dials_id"),
                "wiring": meta.get("wiring"),
                "dials_path": meta.get("dials_path"),
            }
        # Refresh stamp in case dials hot-reloaded mid-game (rare).
        if not game.get("dials_id"):
            meta = _model_meta()
            game["dials_id"] = meta.get("dials_id")
            game["wiring"] = meta.get("wiring")
            game["dials_path"] = meta.get("dials_path")
        game["ended_at"] = time.time()
        you = req.get("you") or {}
        snakes = ((req.get("board") or {}).get("snakes") or [])
        alive = [s for s in snakes if s.get("id")]
        you_alive = any(s.get("id") == you.get("id") for s in alive)
        if you_alive and len(alive) == 1:
            outcome = "win"
        elif you_alive:
            outcome = "survived"
        else:
            outcome = "eliminated"
        game["outcome"] = outcome
        game["final"] = {
            "turn": req.get("turn"),
            "you_health": you.get("health"),
            "you_length": you.get("length"),
            "you_head": you.get("head"),
            "alive": [{"name": s.get("name"), "length": s.get("length")} for s in alive],
        }
        game["analysis"] = analyze_game(game)
        _write(game)
        return game


def _write(game: Dict[str, Any]) -> None:
    _ensure_dir()
    path = _path_for(game["game_id"])
    path.write_text(json.dumps(game, indent=2), encoding="utf-8")
    # pointer to latest
    (LOG_DIR / "latest.json").write_text(
        json.dumps({"game_id": game["game_id"], "path": path.name}, indent=2),
        encoding="utf-8",
    )


def list_games(limit: int = 20) -> List[Dict[str, Any]]:
    _ensure_dir()
    files = sorted(LOG_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for p in files:
        if p.name == "latest.json":
            continue
        try:
            g = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out.append(
            {
                "game_id": g.get("game_id"),
                "outcome": g.get("outcome"),
                "turns": len(g.get("turns") or []),
                "started_at": g.get("started_at"),
                "ended_at": g.get("ended_at"),
                "you_name": g.get("you_name"),
                "final_length": ((g.get("final") or {}).get("you_length")),
                "dials_id": g.get("dials_id"),
                "wiring": g.get("wiring"),
                "source": g.get("source"),
                "file": p.name,
            }
        )
        if len(out) >= limit:
            break
    return out


def load_game(game_id: str) -> Optional[Dict[str, Any]]:
    # "latest" / "last" resolve via pointer file — never treat latest.json as a transcript
    if game_id in ("latest", "last"):
        latest = LOG_DIR / "latest.json"
        if latest.exists():
            try:
                meta = json.loads(latest.read_text(encoding="utf-8"))
                path = LOG_DIR / meta["path"]
                if path.exists() and path.name != "latest.json":
                    return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, KeyError):
                pass
        games = list_games(1)
        return load_game(games[0]["game_id"]) if games else None

    path = _path_for(game_id)
    if not path.exists() or path.name == "latest.json":
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def analyze_game(game: Dict[str, Any]) -> Dict[str, Any]:
    """Derive risk/reward stats + creative neuron wiring suggestions from a transcript."""
    turns = game.get("turns") or []
    if not turns:
        return {"ok": False, "note": "no turns logged"}

    courts = [float((t.get("signals") or {}).get("courtship") or 0) for t in turns]
    safeties = [float((t.get("signals") or {}).get("safety") or 0) for t in turns]
    hungers = [float((t.get("signals") or {}).get("hunger") or 0) for t in turns]
    dangers = [float((t.get("signals") or {}).get("danger_distance") or 0) for t in turns]
    size_advs = [float((t.get("signals") or {}).get("size_advantage") or 0.5) for t in turns]
    cone_ratios = [
        float((t.get("signals") or {}).get("cone_ratio") or (t.get("signals") or {}).get("safety") or 0)
        for t in turns
    ]
    retina_opens = [float((t.get("signals") or {}).get("retina_open") or 0) for t in turns]
    retina_fruits = [float((t.get("signals") or {}).get("retina_fruit") or 0) for t in turns]
    retina_threats = [float((t.get("signals") or {}).get("retina_threat") or 0) for t in turns]
    sector_ents = [float((t.get("signals") or {}).get("sector_entropy") or 0) for t in turns]
    foods = [
        (t.get("signals") or {}).get("food_distance")
        for t in turns
        if (t.get("signals") or {}).get("food_distance") is not None
    ]

    lengths = [((t.get("board") or {}).get("you_length") or 0) for t in turns]
    healths = [((t.get("board") or {}).get("you_health") or 0) for t in turns]
    rival_lens = []
    for t in turns:
        snakes = ((t.get("board") or {}).get("snakes") or [])
        you_len = ((t.get("board") or {}).get("you_length") or 0)
        mx = (t.get("signals") or {}).get("length_max_rival")
        if mx is not None:
            rival_lens.append(int(mx))
        elif snakes:
            lens = [int(s.get("length") or 0) for s in snakes]
            rival_lens.append(max((L for L in lens if L != you_len), default=max(lens) if lens else 0))

    grew = max(lengths) - (lengths[0] if lengths else 0)
    food_eaten = max(0, grew)  # length gain ≈ foods in standard

    # Risky food: moved toward food while danger_distance <= 2
    risky_food = 0
    safe_food = 0
    panic_turns = 0
    court_high = 0
    near_miss = 0  # danger <= 1
    size_dominant = 0
    cone_tight = 0
    for t in turns:
        sig = t.get("signals") or {}
        d = float(sig.get("danger_distance") or 99)
        fd = sig.get("food_distance")
        if d <= 1.5:
            near_miss += 1
        if float(sig.get("safety") or 1) < 0.25:
            panic_turns += 1
        if float(sig.get("courtship") or 0) > 0.65:
            court_high += 1
        if float(sig.get("size_advantage") or 0.5) >= 0.55:
            size_dominant += 1
        if float(sig.get("cone_ratio") or sig.get("safety") or 1) < 0.3:
            cone_tight += 1
        if fd is not None and fd <= 1:
            if d <= 2.5:
                risky_food += 1
            else:
                safe_food += 1

    # Move entropy / commitment
    moves = [t.get("move") for t in turns]
    move_counts = {m: moves.count(m) for m in ("up", "down", "left", "right")}

    avg = lambda xs: (sum(xs) / len(xs)) if xs else 0.0
    n = len(turns)
    peak_len = max(lengths) if lengths else 0
    peak_rival = max(rival_lens) if rival_lens else 0

    # Suggested MaleCNS / pathway wiring (creative mapping from play)
    mappings = [
        {
            "signal": "danger_proximity",
            "stat": f"near_miss_turns={near_miss}/{n} ({100 * near_miss / n:.0f}%)",
            "neuron": "ALPN (threat) + courtship_pC1 gate↓",
            "idea": "When danger_distance ≤ 2, boost ALPN Poisson drive and damp courtship_pC1 — survival over courting.",
            "weight_hint": round(min(1.0, near_miss / max(1, n) * 3), 2),
        },
        {
            "signal": "forward_cone_safety",
            "stat": f"avg_cone_ratio={avg(cone_ratios):.2f}, tight_cone_turns={cone_tight}/{n}",
            "neuron": "MBON (forward space) ← optic lobe cone",
            "idea": "Safety = empty cells in the facing cone (same frame as hex eyes). Low cone → escape turn toward largest coneEmpty neighbor; high cone → allow courtship + food.",
            "weight_hint": round(1.0 - avg(cone_ratios) * 0.5 if avg(cone_ratios) < 0.5 else avg(cone_ratios), 2),
        },
        {
            "signal": "relative_size",
            "stat": f"avg_size_adv={avg(size_advs):.2f}, dominant_turns={size_dominant}/{n}, peak_len={peak_len} vs rival_peak≈{peak_rival}",
            "neuron": "DAN_risk / aSPIC (size vs rivals)",
            "idea": "size_advantage = you vs longest rival. When >0.55, raise DAN risk-seeking and allow H2H approach; when <0.45, bias MBON toward cone space and avoid equal/longer heads.",
            "weight_hint": round(max(avg(size_advs), 1.0 - avg(size_advs)), 2),
        },
        {
            "signal": "food_approach",
            "stat": f"food_eaten≈{food_eaten}, risky_food_frames={risky_food}, safe={safe_food}",
            "neuron": "DAN (reward) + ORN/ALPN food channel",
            "idea": "Close food (dist≤1) → DAN burst. If also danger≤2, split: DAN still fires but MBON-avoidance vetoes unless hunger floor is high (greedy mode).",
            "weight_hint": round(min(1.0, 0.4 + food_eaten / 20), 2),
        },
        {
            "signal": "open_space",
            "stat": f"avg_safety(cone)={avg(safeties):.2f}",
            "neuron": "MBON (space preference)",
            "idea": "Flood-fill still scores moves; cone safety modulates confidence. High cone + high courtship = explore; low cone = tunnel-vision escape.",
            "weight_hint": round(avg(safeties), 2),
        },
        {
            "signal": "courtship_when_safe",
            "stat": f"high_court_turns={court_high}/{n}, avg_court={avg(courts):.2f}",
            "neuron": "courtship_pC1 / vPR6 / TN1",
            "idea": "Courtship drive only when cone safety>0.45. Use as a 'confidence' neuromodulator that slightly increases food greed and shout flair — not raw survival.",
            "weight_hint": round(avg(courts), 2),
        },
        {
            "signal": "panic_escape",
            "stat": f"panic_turns={panic_turns}/{n}",
            "neuron": "descending escape / Kenyon sparse code",
            "idea": "Cone safety<0.25 → sparse KC pattern biased to largest forward-cone neighbor; ignore food entirely for 1–2 turns.",
            "weight_hint": round(min(1.0, panic_turns / max(1, n) * 2), 2),
        },
        {
            "signal": "aggression_h2h",
            "stat": f"size_lead used when longest; dominant_turns={size_dominant}/{n}",
            "neuron": "DAN risk-seeking branch (optional)",
            "idea": "When longer than nearest foe and head adjacent, invert threat into approach (head-to-head hunting). Gate with size_advantage so small flies don't suicide.",
            "weight_hint": round(0.25 + 0.5 * avg(size_advs), 2),
        },
        {
            "signal": "egocentric_vision",
            "stat": "hex eyemap fruit=red, foes=cyan/coral by proximity; cone=open green",
            "neuron": "optic lobe L1/L2 visual → ALPN",
            "idea": "boardToVisual paints open/fruit/threat/self; facet RGB is the same 4-channel retina used to score moves.",
            "weight_hint": 0.78,
        },
        {
            "signal": "retina_sectors",
            "stat": f"avg_open={avg(retina_opens):.2f}, avg_fruit={avg(retina_fruits):.2f}, avg_threat={avg(retina_threats):.2f}, sector_entropy={avg(sector_ents):.2f}",
            "neuron": "facet bags → ALPN (threat) / MBON (open) / DAN (fruit)",
            "idea": "Each candidate move samples forward + lateral + near-field sectors. High threat vetoes fruit; high open pulls toward space. Instantaneous sector_entropy, not game-average.",
            "weight_hint": round(min(1.0, 0.35 + avg(retina_opens) * 0.4 + avg(retina_threats) * 0.4), 2),
        },
    ]

    # Rank what to wire first based on this game's drama
    priority = sorted(mappings, key=lambda m: m["weight_hint"], reverse=True)

    return {
        "ok": True,
        "n_turns": n,
        "outcome": game.get("outcome"),
        "avg_courtship": round(avg(courts), 3),
        "avg_safety": round(avg(safeties), 3),
        "avg_cone_ratio": round(avg(cone_ratios), 3),
        "avg_hunger": round(avg(hungers), 3),
        "avg_danger_distance": round(avg(dangers), 3),
        "avg_size_advantage": round(avg(size_advs), 3),
        "avg_food_distance": round(avg([float(x) for x in foods]), 3) if foods else None,
        "length_start": lengths[0] if lengths else None,
        "length_peak": peak_len,
        "length_end": lengths[-1] if lengths else None,
        "rival_length_peak": peak_rival or None,
        "food_eaten_est": food_eaten,
        "risky_food_frames": risky_food,
        "safe_food_frames": safe_food,
        "near_miss_turns": near_miss,
        "panic_turns": panic_turns,
        "court_high_turns": court_high,
        "size_dominant_turns": size_dominant,
        "cone_tight_turns": cone_tight,
        "move_counts": move_counts,
        "health_end": healths[-1] if healths else None,
        "neuron_mappings": priority,
        "creative_next_steps": [
            "Log each turn's top-2 scored moves; when 2nd-best was safer but we took food, tag as 'greedy risk' for DAN vs MBON conflict studies.",
            "Add a 'scar' memory: cells where we nearly died → temporary inhibitory field on ALPN for N turns (learned hazard map).",
            "Mirror rival head velocity into a dedicated opponent-ORN channel so Kenyon cells can bind 'cyan-left / coral-right'.",
            "Courtship shout when avg courtship over last 5 turns > 0.6 — social signal, not strategy, but fun for Funathon identity.",
            "Weight sector bags by real optic-lobe column density if a lightweight hex lookup becomes cheap enough per turn.",
        ],
    }


def batch_evaluate(limit: int = 20) -> Dict[str, Any]:
    """Aggregate the last N logged games for a session review."""
    metas = list_games(limit)
    if not metas:
        return {"ok": False, "n": 0, "note": "no games logged"}

    games = []
    for m in metas:
        g = load_game(m["game_id"])
        if g:
            games.append(g)
    if not games:
        return {"ok": False, "n": 0, "note": "could not load games"}

    n = len(games)
    wins = sum(1 for g in games if g.get("outcome") == "win")
    elims = sum(1 for g in games if g.get("outcome") == "eliminated")
    survived = sum(1 for g in games if g.get("outcome") == "survived")

    analyses = []
    for g in games:
        a = g.get("analysis") or analyze_game(g)
        if a.get("ok"):
            analyses.append(a)

    def mean(key: str) -> Optional[float]:
        xs = [a[key] for a in analyses if a.get(key) is not None]
        return round(sum(xs) / len(xs), 3) if xs else None

    wirings = []
    for g in games:
        turns = g.get("turns") or []
        if turns:
            w = (turns[-1].get("signals") or {}).get("wiring")
            if w:
                wirings.append(w)
    wiring_mode = max(set(wirings), key=wirings.count) if wirings else None

    # Rank neuron signals by mean weight_hint across games
    weight_sum: Dict[str, float] = {}
    weight_n: Dict[str, int] = {}
    idea_by: Dict[str, str] = {}
    neuron_by: Dict[str, str] = {}
    for a in analyses:
        for m in a.get("neuron_mappings") or []:
            sig = m.get("signal") or "?"
            weight_sum[sig] = weight_sum.get(sig, 0.0) + float(m.get("weight_hint") or 0)
            weight_n[sig] = weight_n.get(sig, 0) + 1
            idea_by[sig] = m.get("idea") or idea_by.get(sig, "")
            neuron_by[sig] = m.get("neuron") or neuron_by.get(sig, "")
    top_maps = sorted(
        [
            {
                "signal": sig,
                "neuron": neuron_by.get(sig),
                "idea": idea_by.get(sig),
                "weight_hint": round(weight_sum[sig] / weight_n[sig], 2),
                "games": weight_n[sig],
            }
            for sig in weight_sum
        ],
        key=lambda m: m["weight_hint"],
        reverse=True,
    )

    food_vals = [a.get("food_eaten_est") or 0 for a in analyses]
    len_peaks = [a.get("length_peak") or 0 for a in analyses]
    rival_peaks = [a.get("rival_length_peak") or 0 for a in analyses if a.get("rival_length_peak") is not None]
    turn_counts = [a.get("n_turns") or 0 for a in analyses]

    verdict_bits = []
    win_rate = wins / n if n else 0
    if win_rate >= 0.45:
        verdict_bits.append("batch looks healthy enough to try a 100-game run")
    elif win_rate >= 0.25:
        verdict_bits.append("mixed — tune food/size before scaling to 100")
    else:
        verdict_bits.append("still losing often — stay at 20 and retune wiring first")
    avg_food = mean("food_eaten_est")
    if avg_food is not None and avg_food < 2:
        verdict_bits.append("food intake low — push starve_hunt / contested food")
    avg_size = mean("avg_size_advantage")
    if avg_size is not None and avg_size < 0.4:
        verdict_bits.append("size disadvantage persistent — length race is the bottleneck")

    return {
        "ok": True,
        "n": n,
        "wins": wins,
        "eliminated": elims,
        "survived": survived,
        "win_rate": round(win_rate, 3),
        "wiring": wiring_mode,
        "avg_turns": round(sum(turn_counts) / len(turn_counts), 1) if turn_counts else None,
        "avg_food_eaten": mean("food_eaten_est"),
        "avg_cone_ratio": mean("avg_cone_ratio"),
        "avg_size_advantage": mean("avg_size_advantage"),
        "avg_length_peak": round(sum(len_peaks) / len(len_peaks), 1) if len_peaks else None,
        "avg_rival_peak": round(sum(rival_peaks) / len(rival_peaks), 1) if rival_peaks else None,
        "avg_near_miss": mean("near_miss_turns"),
        "avg_panic_turns": mean("panic_turns"),
        "food_total": sum(food_vals),
        "neuron_mappings": top_maps[:8],
        "games_ids": [g.get("game_id") for g in games],
        "outcomes": [g.get("outcome") for g in games],
        "verdict": " · ".join(verdict_bits),
        "next_batch_size": 100 if win_rate >= 0.45 else 20,
    }
