"""
Map repo-root ttt_viz_data.json into this activity's experience.json
(ExperienceReplay contract).

  python3 activities/ttt/export_experience.py
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

SRC = REPO_ROOT / "ttt_viz_data.json"
OUT = ACTIVITY_DIR / "experience.json"

RATE_EMPTY = 0.0
RATE_OPP = 110.0
RATE_FLY = 220.0


def board_stimulus_rates(board):
    rates = []
    for v in board:
        if v == 0:
            rates.append(RATE_EMPTY)
        elif v == 1:
            rates.append(RATE_FLY)
        else:
            rates.append(RATE_OPP)
    return rates


def map_state(state_id: str, raw: dict, cell_names: list, move_names: list) -> dict:
    board = raw["board"]
    move_rates = [float(x) for x in raw["move_rates"]]
    cell_rates = raw.get("cell_rates")
    if cell_rates is None:
        cell_rates = board_stimulus_rates(board)
    else:
        cell_rates = [float(x) for x in cell_rates]

    return {
        "rate_curves": raw["rate_curves"],
        "raster": raw["raster"],
        "alpn_rate": float(raw.get("alpn_rate", 0.0)),
        "kc_rate": float(raw.get("kc_rate", 0.0)),
        "mbon_rate": float(raw.get("mbon_rate", 0.0)),
        "dan_rate": float(raw.get("dan_rate", 0.0)),
        "readout": {
            "labels": [f"cell {i}" for i in range(len(move_rates))],
            "values": move_rates,
        },
        "stimulus": {
            "channels": cell_names if cell_names else [f"cell_{i}" for i in range(9)],
            "values": cell_rates,
            "encoding_note": "empty=0 Hz, opponent=110 Hz, fly=220 Hz",
        },
        "activity_payload": {
            "board": board,
            "move_rates": move_rates,
            "cell_rates": cell_rates,
            "move_group_names": move_names,
        },
    }


def map_episode(ep_id: str, outcome: str, raw: dict) -> dict:
    return {
        "id": ep_id,
        "outcome": outcome,
        "step_state_ids": list(raw["fly_turn_state_keys"]),
        "actions": list(raw["fly_moves"]),
        "note": f"Game #{raw.get('game_idx', '?')}",
        "activity_payload": {
            "game_idx": raw.get("game_idx"),
            "fly_moves": list(raw["fly_moves"]),
            "opp_moves": list(raw.get("opp_moves", [])),
            "final_board": list(raw.get("final_board", [])),
        },
    }


def main():
    with open(SRC) as f:
        src = json.load(f)

    meta_src = src["meta"]
    cell_names = meta_src.get("cell_group_names", [])
    move_names = meta_src.get("move_group_names", [])

    states = {
        sid: map_state(sid, raw, cell_names, move_names)
        for sid, raw in src["board_states"].items()
    }

    episodes = []
    for outcome in ("win", "loss"):
        if outcome in src.get("example_games", {}):
            episodes.append(map_episode(outcome, outcome, src["example_games"][outcome]))

    lc = src.get("learning_curve") or {}
    learning = None
    if lc:
        learning = {
            "outcomes": list(lc["outcomes"]),
            "cumulative": list(lc["cumulative_win_rate"]),
            "rolling": list(lc["rolling_win_rate_w15"]),
            "reference": {
                "y": 0.59,
                "label": "~59% random-vs-random reference",
            },
        }

    n = meta_src.get("n_games") or meta_src.get("games_played") or 0
    wins = meta_src.get("wins", 0)
    losses = meta_src.get("losses", 0)
    draws = meta_src.get("draws", 0)
    win_rate = meta_src.get("win_rate")
    if win_rate is None and n:
        win_rate = wins / n

    replay = {
        "meta": {
            "activity_id": "ttt",
            "title": "Fly Brain Console",
            "subtitle": (
                "A real Drosophila male-brain connectome plays tic-tac-toe. "
                "Board cells drive nine olfactory glomeruli; nine descending "
                "neurons read out as move preference. The connectome itself is "
                "never touched — only a small per-cell bias sits on top."
            ),
            "t_run_ms": 150.0,
            "bin_ms": 3.0,
            "stages": list(DEFAULT_STAGES),
            "stage_labels": dict(DEFAULT_STAGE_LABELS),
            "n_episodes": n,
            "wins": wins,
            "losses": losses,
            "draws": draws,
            "win_rate": win_rate,
            "stats": [
                {"label": "Games", "value": n},
                {"label": "Wins", "value": wins, "kind": "win"},
                {"label": "Losses", "value": losses, "kind": "loss"},
                {"label": "Draws", "value": draws},
                {
                    "label": "Win rate",
                    "value": f"{(win_rate or 0) * 100:.0f}%",
                    "kind": "win",
                },
            ],
            "activity_payload": {
                "bias": list(meta_src.get("bias", [0.0] * 9)),
                "cell_group_names": cell_names,
                "move_group_names": move_names,
            },
        },
        "states": states,
        "episodes": episodes,
        "learning": learning,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(replay, f)
    print(f"Wrote {OUT} ({len(states)} states, {len(episodes)} episodes)")


if __name__ == "__main__":
    main()
