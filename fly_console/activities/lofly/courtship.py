"""
Courtship-circuit drive for LoFly.

Wired in lofly_brain.py: courtship_drive scales Poisson input onto
MaleCNS groups courtship_pC1 / courtship_vPR6 / courtship_TN1 (+ DAN bonus).

Strong harmonic change across a mix (Camelot jump + chroma distance)
→ high courtship_drive. Overplay familiarity damps response strength.
"""
from __future__ import annotations

from typing import Sequence

import numpy as np


COURTSHIP_TARGETS = {
    "courtship_pC1": "pC1_* cluster — gate harmonic excitement",
    "courtship_vPR6": "vPR6 — song-pathway related transient",
    "courtship_TN1": "TN1* — courtship song motor-related",
    "DAN": "Dopaminergic — reinforce salient mixes (bonus drive)",
}


def chroma_distance(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine distance between L1-normalized 12-D chroma vectors (0=same, 1=far)."""
    va = np.asarray(a, dtype=float).ravel()
    vb = np.asarray(b, dtype=float).ravel()
    if va.size != 12 or vb.size != 12:
        return 0.5
    na = np.linalg.norm(va)
    nb = np.linalg.norm(vb)
    if na < 1e-9 or nb < 1e-9:
        return 0.5
    cos = float(np.dot(va, vb) / (na * nb))
    cos = max(-1.0, min(1.0, cos))
    return 0.5 * (1.0 - cos)


def courtship_drive(
    camelot_score: float,
    chroma_dist: float,
    tempo_score: float,
    play_familiarity: float,
) -> dict:
    """
    courtship_drive in [0, 1]: peaks when harmonic change is strong but still
    musical (good Camelot + large chroma motion), damped by overplay.
    """
    harmonic_salience = camelot_score * (0.35 + 0.65 * chroma_dist)
    stream_cohesion = 0.5 + 0.5 * tempo_score
    raw = harmonic_salience * stream_cohesion
    damped = raw * (1.0 - 0.75 * play_familiarity)
    drive = float(max(0.0, min(1.0, damped)))
    return {
        "courtship_drive": drive,
        "harmonic_salience": float(harmonic_salience),
        "chroma_distance": float(chroma_dist),
        "play_familiarity": float(play_familiarity),
        "targets": list(COURTSHIP_TARGETS.keys()),
    }
