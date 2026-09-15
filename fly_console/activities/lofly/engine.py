"""
LoFly courtship engine — DJ-flow pheromone with optional reward/penalty toggles.

While a song is playing:
  - The fly sees every other track (catalogue memory)
  - Pheromone = chroma/Camelot harmonic flow + tempo cohesion
    (+ optional novelty / clash penalty / Camelot boost)
  - Courts the strongest trail; partner becomes next playing track

Base goal: songs that flow like a DJ set. Rewards/penalties are toggles
so you can A/B what happens with or without them.

  python3 fly_console/activities/lofly/engine.py --n 20 --fresh
  python3 fly_console/activities/lofly/engine.py --n 20 --fresh \\
      --clash-penalty --camelot-boost
  python3 fly_console/activities/lofly/engine.py --n 20 --fresh --no-novelty
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

ACTIVITY_DIR = Path(__file__).resolve().parent
CATALOGUE_PATH = ACTIVITY_DIR / "catalogue.json"
PLAY_COUNTS_PATH = ACTIVITY_DIR / "play_counts.json"
SESSION_LOG_PATH = ACTIVITY_DIR / "session_log.jsonl"
SESSION_META_PATH = ACTIVITY_DIR / "session_meta.json"

# Base pheromone weights (DJ flow + courtship + novelty)
W_CAMELOT = 0.42
W_TEMPO = 0.25
W_COURTSHIP = 0.20  # chroma courtship drive
W_NOVELTY = 0.13

CAMELOT_OK = frozenset({"same", "relative", "adjacent", "diagonal"})
CLASH_PENALTY_FACTOR = 0.72
CAMELOT_BOOST_FACTOR = 1.08

TICK_SEC = 20.0
MIN_TICKS = 3
MAX_TICKS = 12
STICKY_MARGIN = 0.02


@dataclass
class ScoringToggles:
    """Optional shaping. Novelty defaults on; clash/boost are A/B extras."""

    clash_penalty: bool = False
    novelty: bool = True  # include W_NOVELTY; --no-novelty to drop it
    camelot_boost: bool = False

    def label(self) -> str:
        bits = []
        bits.append("clash" if self.clash_penalty else "no-clash")
        bits.append("novelty" if self.novelty else "no-novelty")
        bits.append("cam-boost" if self.camelot_boost else "no-boost")
        return "+".join(bits)


def load_catalogue() -> dict:
    if not CATALOGUE_PATH.exists():
        raise SystemExit(f"Missing {CATALOGUE_PATH} — run catalogue.py first")
    with open(CATALOGUE_PATH) as f:
        return json.load(f)


def load_play_counts() -> dict:
    if PLAY_COUNTS_PATH.exists():
        with open(PLAY_COUNTS_PATH) as f:
            return json.load(f)
    return {"counts": {}, "total": 0}


def save_play_counts(pc: dict) -> None:
    tmp = PLAY_COUNTS_PATH.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(pc, f, indent=2)
    tmp.replace(PLAY_COUNTS_PATH)


def record_play(pc: dict, track_id: str) -> dict:
    pc.setdefault("counts", {})
    pc["counts"][track_id] = int(pc["counts"].get(track_id, 0)) + 1
    pc["total"] = int(pc.get("total", 0)) + 1
    return pc


def n_ticks_for(duration_s: float) -> int:
    n = int(float(duration_s) / TICK_SEC)
    return max(MIN_TICKS, min(MAX_TICKS, n if n > 0 else MIN_TICKS))


def tempo_score(bpm_a: float, bpm_b: float) -> tuple[float, float]:
    """Prefer beatmatchable tempo (±6%); allow half/double via camelot helper later."""
    from camelot import tempo_compatibility

    tc = tempo_compatibility(bpm_a, bpm_b)
    return float(tc["score"]), float(tc["delta_pct"] or 0.0) / 100.0


def novelty_score(track_id: str, pc: dict, peer_ids: list) -> tuple[float, float]:
    """Higher when underplayed vs peers. Returns (novelty, play_familiarity)."""
    counts = pc.get("counts") or {}
    n = int(counts.get(track_id, 0))
    if not peer_ids:
        fam = min(1.0, n / 3.0)
        return 1.0 - 0.85 * fam, fam
    peer_counts = [int(counts.get(pid, 0)) for pid in peer_ids]
    mean_p = sum(peer_counts) / max(len(peer_counts), 1)
    if mean_p < 1e-9:
        fam = min(1.0, n / 3.0)
    else:
        fam = min(1.0, n / (mean_p + 1.0))
    novelty = 1.0 - 0.85 * fam
    return float(max(0.0, min(1.0, novelty))), float(fam)


def chroma_flow(playing: dict, candidate: dict) -> float:
    """
    Chroma affinity shaped like Camelot wheel motion:
    peak when profiles are related (same/neighbor energy), soft when far.
    """
    from courtship import chroma_distance

    dist = chroma_distance(
        playing.get("chroma_mean", []),
        candidate.get("chroma_mean", []),
    )
    # dist 0 = identical chroma → high cohesion
    # modest motion (~0.15–0.35) still flows; far jumps drop off
    if dist <= 0.12:
        return 1.0 - 0.15 * (dist / 0.12)
    if dist <= 0.35:
        return 0.85 - 0.35 * ((dist - 0.12) / 0.23)
    return max(0.05, 0.50 - 0.8 * (dist - 0.35))


def candidate_pheromone(
    playing: dict,
    candidate: dict,
    pc: dict,
    peer_ids: list,
    toggles: ScoringToggles,
) -> dict:
    from camelot import camelot_distance
    from courtship import chroma_distance, courtship_drive

    cam = camelot_distance(playing["camelot"], candidate["camelot"]) or {
        "kind": "unknown",
        "score": 0.0,
        "number_delta": None,
        "letter_flip": None,
    }
    t_score, t_pct = tempo_score(playing["bpm"], candidate["bpm"])
    nov, fam = novelty_score(candidate["id"], pc, peer_ids)
    cdist = chroma_distance(
        playing.get("chroma_mean", []),
        candidate.get("chroma_mean", []),
    )
    c_flow = chroma_flow(playing, candidate)

    # Familiarity damps courtship drive when novelty is in the blend
    fam_for_court = fam if toggles.novelty else 0.0
    court = courtship_drive(
        camelot_score=float(cam["score"]),
        chroma_dist=cdist,
        tempo_score=t_score,
        play_familiarity=fam_for_court,
    )
    drive = float(court["courtship_drive"])

    if toggles.novelty:
        raw = (
            W_CAMELOT * float(cam["score"])
            + W_TEMPO * t_score
            + W_COURTSHIP * drive
            + W_NOVELTY * nov
        )
    else:
        # Redistribute novelty weight across the other three
        s = W_CAMELOT + W_TEMPO + W_COURTSHIP
        raw = (
            (W_CAMELOT / s) * float(cam["score"])
            + (W_TEMPO / s) * t_score
            + (W_COURTSHIP / s) * drive
        )

    pheromone = raw
    if toggles.clash_penalty and cam["kind"] not in CAMELOT_OK:
        pheromone *= CLASH_PENALTY_FACTOR
    if toggles.camelot_boost and cam["kind"] in CAMELOT_OK:
        pheromone *= CAMELOT_BOOST_FACTOR

    pheromone = float(max(0.0, min(1.0, pheromone)))

    return {
        "track_id": candidate["id"],
        "title": candidate["title"],
        "camelot": candidate["camelot"],
        "bpm": candidate["bpm"],
        "pheromone": pheromone,
        "camelot_kind": cam["kind"],
        "camelot_score": float(cam["score"]),
        "tempo_score": t_score,
        "tempo_delta_pct": t_pct,
        "chroma_flow": float(c_flow),
        "novelty": nov,
        "play_familiarity": fam,
        "composite": pheromone,
        "courtship": court,
        "toggles": asdict(toggles),
    }


def promote_pheromones(
    playing: dict,
    tracks: dict,
    exclude: set,
    pc: dict,
    toggles: ScoringToggles,
) -> list:
    peer_ids = [tid for tid in tracks if tid not in exclude and tid != playing["id"]]
    scored = [
        candidate_pheromone(playing, tracks[tid], pc, peer_ids, toggles)
        for tid in peer_ids
    ]
    scored.sort(key=lambda s: s["pheromone"], reverse=True)
    return scored


def court_during_song(
    playing: dict,
    tracks: dict,
    rng: random.Random,
    recent: list,
    pc: dict,
    toggles: ScoringToggles,
) -> dict:
    cool = max(8, min(20, len(tracks) // 10))
    exclude = set(recent[-cool:]) | {playing["id"]}

    duration = float(playing.get("duration_s", 120.0))
    ticks = n_ticks_for(duration)

    ranked = promote_pheromones(playing, tracks, exclude, pc, toggles)
    if not ranked:
        ranked = promote_pheromones(playing, tracks, {playing["id"]}, pc, toggles)
    if not ranked:
        raise RuntimeError("No courtship candidates")

    courting = dict(rng.choice(ranked))
    initial = {
        "id": courting["track_id"],
        "title": courting["title"],
        "pheromone": courting["pheromone"],
        "camelot_kind": courting["camelot_kind"],
        "composite": courting["pheromone"],
    }

    history = []
    n_switches = 0
    for ti in range(ticks):
        progress = (ti + 1) / ticks
        t_song = progress * duration
        ranked = promote_pheromones(playing, tracks, exclude, pc, toggles)
        best = ranked[0]
        top5 = [
            {
                "id": s["track_id"],
                "title": s["title"],
                "camelot": s["camelot"],
                "kind": s["camelot_kind"],
                "pheromone": round(s["pheromone"], 3),
                "score": round(s["pheromone"], 3),
                "tempo": round(s["tempo_score"], 3),
                "chroma_flow": round(s["chroma_flow"], 3),
                "novelty": round(s["novelty"], 3),
            }
            for s in ranked[:5]
        ]

        switched = False
        if best["pheromone"] > courting["pheromone"] + STICKY_MARGIN:
            courting = dict(best)
            switched = True
            n_switches += 1
        elif (
            best["track_id"] != courting["track_id"]
            and abs(best["pheromone"] - courting["pheromone"]) <= STICKY_MARGIN
            and rng.random() < 0.25
        ):
            courting = dict(best)
            switched = True
            n_switches += 1

        for s in ranked:
            if s["track_id"] == courting["track_id"]:
                courting = dict(s)
                break

        history.append(
            {
                "tick": ti,
                "progress": round(progress, 3),
                "t_song_s": round(t_song, 1),
                "courting_id": courting["track_id"],
                "courting_title": courting["title"],
                "courting_pheromone": round(courting["pheromone"], 4),
                "courting_camelot": courting["camelot"],
                "best_id": best["track_id"],
                "best_pheromone": round(best["pheromone"], 4),
                "switched": switched,
                "top_pheromones": top5,
            }
        )

    oracle = ranked[0]
    final = courting
    regret = float(oracle["pheromone"] - final["pheromone"])
    found_best = final["track_id"] == oracle["track_id"]
    improved = final["pheromone"] > initial["pheromone"] + STICKY_MARGIN / 2

    return {
        "courting_id": final["track_id"],
        "score": final,
        "initial": initial,
        "n_ticks": ticks,
        "n_switches": n_switches,
        "duration_s": duration,
        "history": history,
        "oracle": {
            "id": oracle["track_id"],
            "title": oracle["title"],
            "composite": oracle["pheromone"],
            "pheromone": oracle["pheromone"],
            "camelot_kind": oracle["camelot_kind"],
        },
        "reward": {
            "camelot": final["camelot_score"],
            "tempo": final["tempo_score"],
            "chroma_flow": final["chroma_flow"],
            "courtship_drive": final["courtship"]["courtship_drive"],
            "composite": final["pheromone"],
            "pheromone": final["pheromone"],
            "camelot_ok": final["camelot_kind"] in CAMELOT_OK,
            "improved": improved,
            "found_best": found_best,
            "regret": round(regret, 4),
            "challenge_win": found_best or regret <= 1e-9,
            "n_switches": n_switches,
        },
        "top_alternatives": [
            {
                "id": s["track_id"],
                "title": s["title"],
                "camelot": s["camelot"],
                "kind": s["camelot_kind"],
                "pheromone": round(s["pheromone"], 3),
                "score": round(s["pheromone"], 3),
                "tempo": round(s["tempo_score"], 3),
                "chroma_flow": round(s["chroma_flow"], 3),
                "novelty": round(s["novelty"], 3),
            }
            for s in ranked[:5]
        ],
    }


def run_session(
    n_transitions: int = 24,
    seed: int = 7,
    start_id: str | None = None,
    fresh_counts: bool = False,
    toggles: ScoringToggles | None = None,
):
    sys.path.insert(0, str(ACTIVITY_DIR))
    toggles = toggles or ScoringToggles()
    cat = load_catalogue()
    tracks = cat["tracks"]
    if len(tracks) < 2:
        raise SystemExit("Need ≥2 catalogued tracks")

    rng = random.Random(seed)
    current_id = start_id if start_id in tracks else rng.choice(list(tracks.keys()))
    pc = {"counts": {}, "total": 0} if fresh_counts else load_play_counts()
    recent = []

    if SESSION_LOG_PATH.exists():
        SESSION_LOG_PATH.unlink()

    meta = {
        "toggles": asdict(toggles),
        "toggles_label": toggles.label(),
        "seed": seed,
        "n": n_transitions,
        "fresh_counts": fresh_counts,
        "mode": "dj_flow_pheromone",
    }
    with open(SESSION_META_PATH, "w") as f:
        json.dump(meta, f, indent=2)

    pc = record_play(pc, current_id)
    recent.append(current_id)

    n_ok = 0
    n_best = 0
    print(f"toggles: {toggles.label()}")
    for step in range(n_transitions):
        playing = tracks[current_id]
        result = court_during_song(playing, tracks, rng, recent, pc, toggles)
        next_id = result["courting_id"]
        nxt = tracks[next_id]
        final = result["score"]
        reward = result["reward"]
        n_ok += int(reward["camelot_ok"])
        n_best += int(reward["found_best"])

        event = {
            "t": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "step": step,
            "mode": "dj_flow_pheromone",
            "toggles": asdict(toggles),
            "from_id": current_id,
            "from_title": playing["title"],
            "from_camelot": playing["camelot"],
            "from_bpm": playing["bpm"],
            "from_duration_s": playing.get("duration_s"),
            "to_id": next_id,
            "to_title": nxt["title"],
            "to_camelot": nxt["camelot"],
            "to_bpm": nxt["bpm"],
            "score": final,
            "initial_courting": result["initial"],
            "n_ticks": result["n_ticks"],
            "n_switches": result["n_switches"],
            "courtship_history": result["history"],
            "oracle": result["oracle"],
            "top_alternatives": result["top_alternatives"],
            "reward": reward,
        }
        with open(SESSION_LOG_PATH, "a") as f:
            f.write(json.dumps(event) + "\n")

        print(
            f"{step:02d}  hear {playing['camelot']} {playing['title'][:22]:<22}  "
            f"→{nxt['camelot']} {nxt['title'][:18]:<18}  "
            f"sw={result['n_switches']}/{result['n_ticks']}  "
            f"ph={final['pheromone']:.2f}  "
            f"cam={final['camelot_kind']}"
        )

        current_id = next_id
        pc = record_play(pc, current_id)
        recent.append(current_id)

    save_play_counts(pc)
    print(
        f"Wrote {SESSION_LOG_PATH}  "
        f"toggles={toggles.label()}  "
        f"camelot_flow={n_ok}/{n_transitions}  "
        f"top_trail={n_best}/{n_transitions}  "
        f"library={len(tracks)}"
    )
    return SESSION_LOG_PATH


def main():
    parser = argparse.ArgumentParser(
        description="LoFly DJ-flow courtship (rewards/penalties are toggles)"
    )
    parser.add_argument("--n", type=int, default=24, help="Songs / courtship rounds")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--start", type=str, default=None)
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument(
        "--clash-penalty",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Penalize Camelot clashes in pheromone (default: off)",
    )
    parser.add_argument(
        "--novelty",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Include novelty (0.13) + familiarity damp on courtship (default: on)",
    )
    parser.add_argument(
        "--camelot-boost",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Boost Camelot-legal moves in pheromone (default: off)",
    )
    args = parser.parse_args()
    run_session(
        n_transitions=args.n,
        seed=args.seed,
        start_id=args.start,
        fresh_counts=args.fresh,
        toggles=ScoringToggles(
            clash_penalty=args.clash_penalty,
            novelty=args.novelty,
            camelot_boost=args.camelot_boost,
        ),
    )


if __name__ == "__main__":
    main()
