"""
Shared ExperienceReplay contract for the Fly Console.

Activity adapters (tic-tac-toe, odor perception, …) export into this shape.
The console shell renders cascade / raster / learning from TrialExperience;
activity-specific chrome reads activity_payload only.
"""
from __future__ import annotations

from typing import Any, Dict, List, NotRequired, Optional, TypedDict


DEFAULT_STAGES = ["ALPN", "Kenyon_Cell", "MBON", "DAN"]
DEFAULT_STAGE_LABELS = {
    "ALPN": "ALPN",
    "Kenyon_Cell": "Kenyon cell",
    "MBON": "MBON",
    "DAN": "DAN",
}


class Readout(TypedDict):
    labels: List[str]
    values: List[float]


class Stimulus(TypedDict):
    channels: List[str]
    values: List[float]
    encoding_note: NotRequired[str]


class TrialExperience(TypedDict):
    """One connectome trial: pathway dynamics + optional I/O vectors."""

    rate_curves: Dict[str, List[float]]
    raster: Dict[str, Any]  # stage -> list of {n, t} or list of spike-time lists
    alpn_rate: NotRequired[float]
    kc_rate: NotRequired[float]
    mbon_rate: NotRequired[float]
    dan_rate: NotRequired[float]
    readout: NotRequired[Readout]
    stimulus: NotRequired[Stimulus]
    # Opaque bag for activity UI (board, bias, odor name, …). Shell ignores this.
    activity_payload: NotRequired[Dict[str, Any]]


class Episode(TypedDict):
    id: str
    outcome: NotRequired[str]  # win | loss | draw | correct | incorrect | …
    step_state_ids: List[str]
    actions: NotRequired[List[Any]]
    note: NotRequired[str]
    activity_payload: NotRequired[Dict[str, Any]]


class LearningReference(TypedDict):
    y: float
    label: str


class LearningCurve(TypedDict):
    outcomes: List[str]
    cumulative: List[float]
    rolling: List[float]
    reference: NotRequired[LearningReference]


class ExperienceMeta(TypedDict):
    activity_id: str
    title: str
    subtitle: str
    t_run_ms: float
    bin_ms: float
    stages: List[str]
    stage_labels: Dict[str, str]
    n_episodes: NotRequired[int]
    wins: NotRequired[int]
    losses: NotRequired[int]
    draws: NotRequired[int]
    win_rate: NotRequired[float]
    accuracy: NotRequired[float]
    stats: NotRequired[List[Dict[str, Any]]]  # [{label, value, kind?}]
    activity_payload: NotRequired[Dict[str, Any]]


class ExperienceReplay(TypedDict):
    meta: ExperienceMeta
    states: Dict[str, TrialExperience]
    episodes: List[Episode]
    learning: NotRequired[Optional[LearningCurve]]
