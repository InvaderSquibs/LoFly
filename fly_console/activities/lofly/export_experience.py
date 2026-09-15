"""
Export a LoFly DJ session into ExperienceReplay for the Fly Console.

Maps:
  stimulus  → 12 chroma bins (what the Bug "hears")
  readout   → transition scores (Camelot / tempo / courtship / composite)
  rate_curves / raster → feature-derived stand-ins until a courtship subgraph
                        is extractable from MaleCNS (see courtship.py)

  cd fly_console && python3 activities/lofly/export_experience.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ACTIVITY_DIR = Path(__file__).resolve().parent
CONSOLE_DIR = ACTIVITY_DIR.parents[1]
sys.path.insert(0, str(CONSOLE_DIR))
sys.path.insert(0, str(ACTIVITY_DIR))

from experience_schema import DEFAULT_STAGE_LABELS, DEFAULT_STAGES  # noqa: E402

CATALOGUE_PATH = ACTIVITY_DIR / "catalogue.json"
SESSION_LOG_PATH = ACTIVITY_DIR / "session_log.jsonl"
PLAY_COUNTS_PATH = ACTIVITY_DIR / "play_counts.json"
BRAIN_TRIALS_PATH = ACTIVITY_DIR / "brain_trials.json"
SESSION_META_PATH = ACTIVITY_DIR / "session_meta.json"
OUT = ACTIVITY_DIR / "experience.json"

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
T_RUN_MS = 150.0
BIN_MS = 3.0
N_BINS = int(T_RUN_MS / BIN_MS)


def _feature_curves(track: dict, courtship_drive: float) -> dict:
    """
    Build fake-but-structured pathway curves from audio features so the shared
    console panels light up. ALPN≈chroma energy, KC≈onset/spectral richness,
    MBON≈tempo stability proxy, DAN≈courtship drive (reward).
    """
    chroma = np.asarray(track["chroma_mean"], dtype=float)
    energy = float(chroma.mean())
    onset = float(track.get("onset_density_hz", 1.0))
    bright = float(track.get("spectral_centroid_hz", 2000.0)) / 8000.0

    t = np.linspace(0, 1, N_BINS)
    # rise then settle — vaguely like a sensory cascade
    rise = 1.0 - np.exp(-6 * t)
    settle = 0.85 + 0.15 * np.sin(2 * np.pi * t * 2)

    alpn = (40 + 180 * energy) * rise * settle
    kc = (20 + 120 * min(onset / 5.0, 1.5) + 40 * bright) * rise**1.4
    mbon = (30 + 80 * (track["bpm"] / 120.0)) * rise**1.2
    dan = (10 + 200 * courtship_drive) * rise**1.6

    noise = lambda scale: 1.0 + 0.04 * np.random.randn(N_BINS)

    return {
        "ALPN": [round(float(x), 2) for x in alpn * noise(1)],
        "Kenyon_Cell": [round(float(x), 2) for x in kc * noise(1)],
        "MBON": [round(float(x), 2) for x in mbon * noise(1)],
        "DAN": [round(float(x), 2) for x in dan * noise(1)],
    }


def _fake_raster(curves: dict, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    raster = {}
    for stage, curve in curves.items():
        rows = []
        n_neurons = 24
        for ni in range(n_neurons):
            times = []
            for bi, hz in enumerate(curve):
                # poisson-ish spikes in bin
                p = min(0.85, hz / 250.0)
                if rng.random() < p:
                    times.append(round(bi * BIN_MS + float(rng.uniform(0, BIN_MS)), 1))
            rows.append({"n": ni, "t": times})
        raster[stage] = rows
    return raster


def load_session():
    if not SESSION_LOG_PATH.exists():
        raise SystemExit(f"No session log at {SESSION_LOG_PATH} — run engine.py")
    events = []
    with open(SESSION_LOG_PATH) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def main():
    with open(CATALOGUE_PATH) as f:
        cat = json.load(f)
    tracks = cat["tracks"]
    events = load_session()
    pc = {"counts": {}, "total": 0}
    if PLAY_COUNTS_PATH.exists():
        with open(PLAY_COUNTS_PATH) as f:
            pc = json.load(f)

    session_meta = {}
    if SESSION_META_PATH.exists():
        with open(SESSION_META_PATH) as f:
            session_meta = json.load(f)
    toggles = session_meta.get("toggles") or (events[0].get("toggles") if events else {}) or {}
    toggles_label = session_meta.get("toggles_label") or (
        "+".join(
            [
                "clash" if toggles.get("clash_penalty") else "no-clash",
                "novelty"
                if toggles.get("novelty", toggles.get("novelty_penalty", True))
                else "no-novelty",
                "cam-boost" if toggles.get("camelot_boost") else "no-boost",
            ]
        )
    )

    np.random.seed(42)
    brain = {}
    if BRAIN_TRIALS_PATH.exists():
        with open(BRAIN_TRIALS_PATH) as f:
            brain = json.load(f).get("trials", {})

    states = {}
    episodes_steps = []
    outcomes = []
    courtship_series = []
    n_brain = 0

    for ev in events:
        sid = f"mix_{ev['step']:03d}"
        to_tr = tracks[ev["to_id"]]
        from_tr = tracks[ev["from_id"]]
        reward = ev["reward"]
        court = ev["score"]["courtship"]["courtship_drive"]
        courtship_series.append(court)
        # Challenge: improve from random courtship toward oracle by song end
        win = bool(reward.get("challenge_win", reward.get("camelot_ok")))
        outcomes.append("win" if win else "loss")

        bt = brain.get(sid, {}).get("sim")
        if bt and "rate_curves" in bt and "raster" in bt:
            n_brain += 1
            curves = bt["rate_curves"]
            raster = bt["raster"]
            alpn = float(bt["alpn_rate"])
            kc = float(bt["kc_rate"])
            mbon = float(bt["mbon_rate"])
            dan = float(bt["dan_rate"])
            source = "brian2"
            court_rates = {
                "pC1": float(bt.get("courtship_pC1_rate", 0)),
                "vPR6": float(bt.get("courtship_vPR6_rate", 0)),
                "TN1": float(bt.get("courtship_TN1_rate", 0)),
            }
        else:
            curves = _feature_curves(from_tr, court)
            raster = _fake_raster(curves, seed=1000 + ev["step"])
            alpn = float(np.mean(curves["ALPN"]))
            kc = float(np.mean(curves["Kenyon_Cell"]))
            mbon = float(np.mean(curves["MBON"]))
            dan = float(np.mean(curves["DAN"]))
            source = "feature_standin"
            court_rates = {}

        # Stimulus = song being heard (playing), not the courted partner
        chroma = from_tr["chroma_mean"]
        init = ev.get("initial_courting") or {}
        oracle = ev.get("oracle") or {}
        states[sid] = {
            "rate_curves": curves,
            "raster": raster,
            "alpn_rate": alpn,
            "kc_rate": kc,
            "mbon_rate": mbon,
            "dan_rate": dan,
            "stimulus": {
                "channels": PITCH_NAMES,
                "values": [float(x) for x in chroma],
                "encoding_note": (
                    "Playing-song chroma → ORN channels (Brian2)"
                    if source == "brian2"
                    else "Playing-song chroma — stand-in until brain trial"
                ),
            },
            "readout": {
                "labels": [
                    "camelot",
                    "tempo",
                    "courtship",
                    "composite",
                    "regret",
                    "switches",
                ],
                "values": [
                    float(ev["score"]["camelot_score"]),
                    float(ev["score"]["tempo_score"]),
                    float(court),
                    float(ev["score"]["composite"]),
                    float(reward.get("regret", 0)),
                    float(reward.get("n_switches", ev.get("n_switches", 0))),
                ],
            },
            "activity_payload": {
                "playing_title": ev["from_title"],
                "playing_camelot": ev["from_camelot"],
                "playing_bpm": ev["from_bpm"],
                "playing_duration_s": ev.get("from_duration_s"),
                "courting_title": ev["to_title"],
                "courting_camelot": ev["to_camelot"],
                "courting_bpm": ev["to_bpm"],
                "from_title": ev["from_title"],
                "to_title": ev["to_title"],
                "from_camelot": ev["from_camelot"],
                "to_camelot": ev["to_camelot"],
                "from_bpm": ev["from_bpm"],
                "to_bpm": ev["to_bpm"],
                "from_duration_s": ev.get("from_duration_s"),
                "camelot_kind": ev["score"]["camelot_kind"],
                "pheromone": float(ev["score"].get("pheromone", court)),
                "chroma_flow": float(ev["score"].get("chroma_flow", 0)),
                "toggles": ev.get("toggles") or toggles,
                "courtship_drive": court,
                "courtship_targets": ev["score"].get("courtship", {}).get("targets", []),
                "courtship_rates_hz": court_rates,
                "top_alternatives": ev.get("top_alternatives")
                or ev["score"].get("top_alternatives", []),
                "from_chroma": from_tr["chroma_mean"],
                "to_chroma": to_tr["chroma_mean"],
                "audio_path": from_tr["path"],
                "partner_audio_path": to_tr["path"],
                "brain_source": source,
                "n_ticks": ev.get("n_ticks"),
                "n_switches": ev.get("n_switches"),
                "courtship_history": ev.get("courtship_history", []),
                "initial_courting": init,
                "oracle": oracle,
                "improved": reward.get("improved"),
                "found_best": reward.get("found_best"),
                "regret": reward.get("regret"),
                "challenge_win": reward.get("challenge_win"),
            },
        }
        episodes_steps.append(sid)

    # cumulative / rolling "Camelot-ok rate" as learning curve
    n = len(outcomes)
    cum, rolling = [], []
    wins = 0
    window = 8
    for i, o in enumerate(outcomes):
        wins += int(o == "win")
        cum.append(wins / (i + 1))
        w = outcomes[max(0, i - window + 1) : i + 1]
        rolling.append(sum(1 for x in w if x == "win") / len(w))

    n_ok = sum(1 for o in outcomes if o == "win")
    replay = {
        "meta": {
            "activity_id": "lofly",
            "title": "LoFly",
            "subtitle": (
                "LoFly hears one song while seeing the whole crate. "
                "Pheromone = Camelot (0.42) + tempo (0.25) + chroma courtship "
                f"(0.20) + novelty (0.13); toggles: {toggles_label}."
            ),
            "t_run_ms": T_RUN_MS,
            "bin_ms": BIN_MS,
            "stages": list(DEFAULT_STAGES),
            "stage_labels": {
                **DEFAULT_STAGE_LABELS,
                "DAN": "DAN (courtship reward)",
            },
            "n_episodes": n,
            "wins": n_ok,
            "losses": n - n_ok,
            "win_rate": n_ok / n if n else 0.0,
            "stats": [
                {"label": "Songs", "value": n},
                {"label": "Best lock", "value": n_ok, "kind": "win"},
                {"label": "Missed", "value": n - n_ok, "kind": "loss"},
                {
                    "label": "Lock rate",
                    "value": f"{(100 * n_ok / n) if n else 0:.0f}%",
                    "kind": "win",
                },
                {"label": "Library", "value": len(tracks)},
            ],
            "activity_payload": {
                "bug_name": "LoFly",
                "bug_role": "fly DJ · chroma/Camelot flow courtship",
                "catalogue_n": len(tracks),
                "play_total": pc.get("total", 0),
                "mean_courtship": float(np.mean(courtship_series)) if courtship_series else 0,
                "brain_trials": n_brain,
                "brain_trials_total": len(events),
                "pheromone_rule": "camelot+tempo+courtship+novelty",
                "toggles": toggles,
                "toggles_label": toggles_label,
            },
        },
        "states": states,
        "episodes": [
            {
                "id": "session",
                "outcome": "win" if (n_ok / max(n, 1)) >= 0.5 else "loss",
                "step_state_ids": episodes_steps,
                "actions": [ev["to_id"] for ev in events],
                "note": f"LoFly courtship · {n} songs",
                "activity_payload": {"n_transitions": n},
            }
        ],
        "learning": {
            "outcomes": outcomes,
            "cumulative": cum,
            "rolling": rolling,
            "reference": {
                "y": 0.35,
                "label": "~chance of locking Camelot-best if stuck on first random court",
            },
        },
    }

    with open(OUT, "w") as f:
        json.dump(replay, f)
    print(
        f"Wrote {OUT} ({len(states)} mix states, "
        f"{n_brain}/{len(events)} from Brian2)"
    )


if __name__ == "__main__":
    main()
