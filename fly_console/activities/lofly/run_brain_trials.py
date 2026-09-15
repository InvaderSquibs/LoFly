"""
Run Brian2 listening trials for each mix in session_log.jsonl.

For every transition:
  - stimulus = destination track chroma (what LoFly is now hearing)
  - courtship_drive = mix harmonic-change signal from the DJ engine
  - records real ALPN/KC/MBON/DAN curves + courtship group rates

Checkpointed to brain_trials.json after every step (resume-safe).

  cd /path/to/fly-brain
  python3 fly_console/activities/lofly/run_brain_trials.py --limit 5   # smoke
  python3 fly_console/activities/lofly/run_brain_trials.py            # full session
  python3 fly_console/activities/lofly/export_experience.py           # prefers brain data
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ACTIVITY_DIR = Path(__file__).resolve().parent
CATALOGUE_PATH = ACTIVITY_DIR / "catalogue.json"
SESSION_LOG_PATH = ACTIVITY_DIR / "session_log.jsonl"
OUT_PATH = ACTIVITY_DIR / "brain_trials.json"


def load_json(path, default):
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return default


def save_trials(trials: dict) -> None:
    tmp = OUT_PATH.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(trials, f)
    tmp.replace(OUT_PATH)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Max new trials this run")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, str(ACTIVITY_DIR))
    import lofly_brain as brain  # noqa: E402

    with open(CATALOGUE_PATH) as f:
        tracks = json.load(f)["tracks"]
    if not SESSION_LOG_PATH.exists():
        raise SystemExit(f"No {SESSION_LOG_PATH} — run engine.py first")

    events = []
    with open(SESSION_LOG_PATH) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))

    trials = load_json(OUT_PATH, {"trials": {}, "meta": {}})
    done = 0
    for ev in events:
        key = f"mix_{ev['step']:03d}"
        if key in trials["trials"] and not args.force:
            continue
        to_tr = tracks[ev["to_id"]]
        drive = float(ev["score"]["courtship"]["courtship_drive"])
        chroma = to_tr["chroma_mean"]
        t0 = time.time()
        print(f"sim {key}  drive={drive:.2f}  {to_tr['title'][:40]!r} ...", flush=True)
        sim = brain.simulate_listening(
            chroma, courtship_drive=drive, seed=1000 + ev["step"], with_raster=True
        )
        trials["trials"][key] = {
            "step": ev["step"],
            "to_id": ev["to_id"],
            "courtship_drive": drive,
            "sim": sim,
            "elapsed_s": round(time.time() - t0, 2),
        }
        trials["meta"] = {
            "n_trials": len(trials["trials"]),
            "n_neurons": brain.N,
            "t_run_ms": brain.T_RUN_MS,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        save_trials(trials)
        done += 1
        print(
            f"  ok {time.time() - t0:.1f}s  "
            f"ALPN={sim['alpn_rate']:.1f} KC={sim['kc_rate']:.1f} "
            f"DAN={sim['dan_rate']:.1f} pC1={sim['courtship_pC1_rate']:.1f}"
        )
        if args.limit and done >= args.limit:
            break

    print(f"brain_trials: {len(trials['trials'])} / {len(events)} → {OUT_PATH}")


if __name__ == "__main__":
    main()
