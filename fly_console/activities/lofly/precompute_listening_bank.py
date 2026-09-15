"""
Precompute Brian2 listening fingerprints for LoFly live mode.

For each track: quiet (drive=0) + hot (drive=0.75) trials with real
MaleCNS subgraph rates/curves. Live console interpolates by courtship drive.

  python3 fly_console/activities/lofly/precompute_listening_bank.py --limit 8
  python3 fly_console/activities/lofly/precompute_listening_bank.py  # resume all
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ACTIVITY_DIR = Path(__file__).resolve().parent
CATALOGUE_PATH = ACTIVITY_DIR / "catalogue.json"
OUT_PATH = ACTIVITY_DIR / "listening_bank.json"

HOT_DRIVE = 0.75


def load_bank():
    if OUT_PATH.exists():
        with open(OUT_PATH) as f:
            return json.load(f)
    return {"tracks": {}, "meta": {}}


def save_bank(bank: dict) -> None:
    tmp = OUT_PATH.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(bank, f)
    tmp.replace(OUT_PATH)


def slim_sim(sim: dict) -> dict:
    """Keep what the console needs; drop huge unused fields if any."""
    return {
        "alpn_rate": sim["alpn_rate"],
        "kc_rate": sim["kc_rate"],
        "mbon_rate": sim["mbon_rate"],
        "dan_rate": sim["dan_rate"],
        "courtship_pC1_rate": sim.get("courtship_pC1_rate", 0),
        "courtship_vPR6_rate": sim.get("courtship_vPR6_rate", 0),
        "courtship_TN1_rate": sim.get("courtship_TN1_rate", 0),
        "courtship_drive": sim.get("courtship_drive", 0),
        "rate_curves": sim.get("rate_curves", {}),
        "raster": sim.get("raster", {}),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Max new tracks this run")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    sys.path.insert(0, str(ACTIVITY_DIR))
    import lofly_brain as brain  # noqa: E402

    with open(CATALOGUE_PATH) as f:
        tracks = json.load(f)["tracks"]

    bank = load_bank()
    ids = sorted(tracks.keys())
    # Prefer tracks that appear often in live random starts: shuffle with seed
    rng = __import__("random").Random(args.seed)
    rng.shuffle(ids)

    done = 0
    for tid in ids:
        entry = bank["tracks"].get(tid)
        if entry and not args.force and "quiet" in entry and "hot" in entry:
            continue
        tr = tracks[tid]
        chroma = tr["chroma_mean"]
        print(f"bank {tr['title'][:42]!r} ...", flush=True)
        t0 = time.time()
        quiet = brain.simulate_listening(
            chroma, courtship_drive=0.0, seed=hash(tid) % 100000, with_raster=True
        )
        hot = brain.simulate_listening(
            chroma,
            courtship_drive=HOT_DRIVE,
            seed=(hash(tid) % 100000) + 1,
            with_raster=True,
        )
        bank["tracks"][tid] = {
            "title": tr["title"],
            "camelot": tr["camelot"],
            "quiet": slim_sim(quiet),
            "hot": slim_sim(hot),
            "hot_drive": HOT_DRIVE,
            "elapsed_s": round(time.time() - t0, 2),
        }
        bank["meta"] = {
            "n_tracks": len(bank["tracks"]),
            "n_neurons": brain.N,
            "t_run_ms": brain.T_RUN_MS,
            "bin_ms": brain.BIN_MS,
            "hot_drive": HOT_DRIVE,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        save_bank(bank)
        done += 1
        print(
            f"  ok {time.time() - t0:.1f}s  "
            f"quiet ALPN={quiet['alpn_rate']:.0f}  "
            f"hot DAN={hot['dan_rate']:.0f} pC1={hot['courtship_pC1_rate']:.0f}  "
            f"bank={len(bank['tracks'])}/{len(tracks)}"
        )
        if args.limit and done >= args.limit:
            break

    print(f"listening_bank: {len(bank['tracks'])} / {len(tracks)} → {OUT_PATH}")


if __name__ == "__main__":
    main()
