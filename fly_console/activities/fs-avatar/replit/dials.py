"""Load / save FS-Avatar policy dials for ladder versions."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

ROOT = Path(__file__).resolve().parent
DEFAULT_DIALS_PATH = ROOT / "ladder" / "dials" / "leader.json"

_DEFAULTS: Dict[str, Any] = {
    "id": "defaults",
    "wiring": "retina_sectors_v1_orchard",
    "panic_food_gate": 0.8,
    "panic_safety_thresh": 0.18,
    "panic_danger_thresh": 1.0,
    "panic_tunnel_thresh": 0.08,
    "starve_blocks_panic_above": 0.55,
    "fruit_hard_danger": 1.0,
    "fruit_soft_danger": 2.0,
    "fruit_soft_scale": 0.4,
    "wall_counts_as_danger": True,
    "undersized_food_gate": 1.4,
    "catchup_len_gap": 2,
    "catchup_food_gate": 1.55,
    "race_food_gate": 1.35,
    "exclusive_near_boost": 1.15,
    "smell_panic_dampen": 0.75,
    "bite_override_panic": True,
    # Early H2H yield (climb handoff: mutual heads ≤ turn 14)
    "early_game_turns": 22,
    "early_aggression_cap": 0.35,
    "early_food_gate_scale": 1.0,
    "equal_or_longer_head_threat": 7.0,
    "shorter_head_threat": 0.35,
    "race_threat_soften": 1.0,
    "food_cell_commits_bite": True,
    "bite_commit_boost": 1.75,
    "smell_min_scale": 0.6,
    "pocket_fit_margin": 5,
    "long_body_space_weight": 2.2,
    "tight_pocket_penalty": 0.03,
    "food_requires_pocket_fit": True,
    "food_pocket_starve_override": 0.7,
    "self_hug_penalty": 2.0,
    "followup_fit_margin": 3,
    "escape_flood_weight": 0.08,
    "escape_follow_weight": 0.1,
    "escape_food_scale": 0.35,
    "dead_end_penalty": 12.0,
    "escape_wall_weight": 2.2,
    "edge_trap_penalty": 6.0,
    "near_edge_penalty": 2.0,
}

_cache: Dict[str, Any] = {}
_cache_path: str = ""
_cache_mtime: float = -1.0


def dials_path() -> Optional[Path]:
    """Resolve dials file. FS_AVATAR_DIALS='-' or '' → built-in defaults (no file)."""
    if "FS_AVATAR_DIALS" in os.environ:
        raw = os.environ.get("FS_AVATAR_DIALS") or ""
        if raw in ("", "-", "defaults", "none"):
            return None
        return Path(raw).expanduser().resolve()
    return DEFAULT_DIALS_PATH


def load_dials(force: bool = False) -> Dict[str, Any]:
    global _cache, _cache_path, _cache_mtime
    path = dials_path()
    key = str(path) if path else "__defaults__"
    try:
        mtime = path.stat().st_mtime if path and path.is_file() else -1.0
    except OSError:
        mtime = -1.0
    if not force and _cache and key == _cache_path and mtime == _cache_mtime:
        return _cache
    data = dict(_DEFAULTS)
    if path and path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data.update(loaded)
        except (OSError, json.JSONDecodeError):
            pass
    _cache = data
    _cache_path = key
    _cache_mtime = mtime
    return data


def save_dials(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
