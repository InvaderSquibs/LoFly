"""
Map repo-root viz_data.json into this activity's experience.json
(ExperienceReplay contract).

  python3 activities/perception/export_experience.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ACTIVITY_DIR = Path(__file__).resolve().parent
CONSOLE_DIR = ACTIVITY_DIR.parents[1]  # fly_console/
REPO_ROOT = CONSOLE_DIR.parent
sys.path.insert(0, str(CONSOLE_DIR))

from experience_schema import DEFAULT_STAGE_LABELS, DEFAULT_STAGES  # noqa: E402

SRC = REPO_ROOT / "viz_data.json"
OUT = ACTIVITY_DIR / "experience.json"

PATHWAY_CORE = ["ALPN", "Kenyon_Cell", "MBON", "DAN"]


def mean_rate_from_curve(curve):
    if not curve:
        return 0.0
    return float(sum(curve) / len(curve))


def normalize_raster(raw_raster: dict) -> dict:
    """Perception viz stores plain spike-time lists; console expects {n, t}."""
    out = {}
    for stage, rows in raw_raster.items():
        if stage not in PATHWAY_CORE:
            continue
        norm = []
        for row in rows:
            if isinstance(row, dict) and "t" in row:
                norm.append({"n": row.get("n", 0), "t": list(row["t"])})
            else:
                times = list(row) if row else []
                norm.append({"n": 0, "t": times})
        out[stage] = norm
    return out


def map_condition(name: str, raw: dict, pretty: dict, pathway: list) -> dict:
    curves = {s: list(raw["rate_curves"][s]) for s in PATHWAY_CORE if s in raw["rate_curves"]}
    # Stimulus: ORN / stim_* input groups only (not descending motor)
    stim_keys = [
        g
        for g in pathway
        if g in raw["rate_curves"]
        and (g.startswith("stim_") or "ORN" in g)
        and g not in PATHWAY_CORE
    ]
    stim_values = [mean_rate_from_curve(raw["rate_curves"][g]) for g in stim_keys]
    stim_labels = [pretty.get(g, g) for g in stim_keys]

    # Readout: core pathway stages (+ descending if present)
    readout_keys = [
        g for g in pathway if g in raw["rate_curves"] and g not in stim_keys
    ]
    readout_vals = [mean_rate_from_curve(raw["rate_curves"][g]) for g in readout_keys]
    readout_labels = [pretty.get(g, g) for g in readout_keys]

    return {
        "rate_curves": curves,
        "raster": normalize_raster(raw.get("raster", {})),
        "alpn_rate": mean_rate_from_curve(raw["rate_curves"].get("ALPN", [])),
        "kc_rate": mean_rate_from_curve(raw["rate_curves"].get("Kenyon_Cell", [])),
        "mbon_rate": mean_rate_from_curve(raw["rate_curves"].get("MBON", [])),
        "dan_rate": mean_rate_from_curve(raw["rate_curves"].get("DAN", [])),
        "readout": {"labels": readout_labels, "values": readout_vals},
        "stimulus": {
            "channels": stim_labels,
            "values": stim_values,
            "encoding_note": "Mean ORN / stimulus-group rate over the trial",
        },
        "activity_payload": {
            "condition": name,
            "pretty_name": pretty.get(name, name.replace("_", " ")),
            "group_sizes": raw.get("group_sizes", {}),
        },
    }


def main():
    with open(SRC) as f:
        src = json.load(f)

    pretty = src.get("pretty_names", {})
    pathway = src.get("pathway_order", [])
    t_run = float(src.get("t_run_ms", 300.0))
    bin_ms = float(src.get("bin_ms", 3.0))

    states = {}
    episodes = []
    for name, raw in src.get("conditions", {}).items():
        states[name] = map_condition(name, raw, pretty, pathway)
        episodes.append(
            {
                "id": name,
                "outcome": name,
                "step_state_ids": [name],
                "actions": [],
                "note": pretty.get(name, name.replace("_", " ")),
                "activity_payload": {"condition": name},
            }
        )

    stage_labels = {
        s: pretty.get(s, DEFAULT_STAGE_LABELS.get(s, s)) for s in DEFAULT_STAGES
    }

    replay = {
        "meta": {
            "activity_id": "perception",
            "title": "Fly Brain Console",
            "subtitle": (
                "Same MaleCNS olfactory pathway under two odor conditions. "
                "Stimulus drives real ORN glomeruli; ALPN → Kenyon → MBON → DAN "
                "cascade is the shared fly experience — no game board."
            ),
            "t_run_ms": t_run,
            "bin_ms": bin_ms,
            "stages": list(DEFAULT_STAGES),
            "stage_labels": stage_labels,
            "n_episodes": len(episodes),
            "stats": [
                {"label": "Conditions", "value": len(episodes)},
                {"label": "Trial", "value": f"{t_run:.0f} ms"},
                {"label": "Bin", "value": f"{bin_ms:.0f} ms"},
            ],
            "activity_payload": {
                "pathway_order": pathway,
                "pretty_names": pretty,
            },
        },
        "states": states,
        "episodes": episodes,
        "learning": None,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(replay, f)
    print(f"Wrote {OUT} ({len(states)} states, {len(episodes)} episodes)")


if __name__ == "__main__":
    main()
