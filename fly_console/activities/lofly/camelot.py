"""
Camelot wheel helpers for LoFly (Bug DJ).

Wheel layout (harmonic mixing):
  1A–12A = minor keys, 1B–12B = major keys
Compatible moves (classic DJ rules):
  - same Camelot code (perfect)
  - ±1 number, same letter (adjacent)
  - same number, flip letter (relative major/minor)
  - ±1 number + letter flip (energy / mood shift — scored lower)
"""
from __future__ import annotations

from typing import Optional, Tuple

# Pitch-class index 0=C … 11=B → Camelot (number, letter)
# Minor (A) and major (B) tables from Open Key / Camelot standard.
_MINOR = {
    0: (5, "A"),   # C minor
    1: (12, "A"),  # C# / Db minor
    2: (7, "A"),   # D minor
    3: (2, "A"),   # D# / Eb minor
    4: (9, "A"),   # E minor
    5: (4, "A"),   # F minor
    6: (11, "A"),  # F# / Gb minor
    7: (6, "A"),   # G minor
    8: (1, "A"),   # G# / Ab minor
    9: (8, "A"),   # A minor
    10: (3, "A"),  # A# / Bb minor
    11: (10, "A"), # B minor
}
_MAJOR = {
    0: (8, "B"),   # C major
    1: (3, "B"),   # C# / Db major
    2: (10, "B"),  # D major
    3: (5, "B"),   # D# / Eb major
    4: (12, "B"),  # E major
    5: (7, "B"),   # F major
    6: (2, "B"),   # F# / Gb major
    7: (9, "B"),   # G major
    8: (4, "B"),   # G# / Ab major
    9: (11, "B"),  # A major
    10: (6, "B"),  # A# / Bb major
    11: (1, "B"),  # B major
}

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def key_to_camelot(pitch_class: int, mode: str) -> str:
    """pitch_class 0–11, mode 'major'|'minor' → e.g. '8A'."""
    table = _MAJOR if mode == "major" else _MINOR
    n, letter = table[int(pitch_class) % 12]
    return f"{n}{letter}"


def parse_camelot(code: str) -> Optional[Tuple[int, str]]:
    if not code or len(code) < 2:
        return None
    letter = code[-1].upper()
    try:
        num = int(code[:-1])
    except ValueError:
        return None
    if letter not in ("A", "B") or not (1 <= num <= 12):
        return None
    return num, letter


def camelot_distance(a: str, b: str) -> Optional[dict]:
    """
    Classify transition quality between two Camelot codes.
    Returns dict with kind, number_delta, letter_flip, score in [0, 1].
    """
    pa, pb = parse_camelot(a), parse_camelot(b)
    if not pa or not pb:
        return None
    na, la = pa
    nb, lb = pb
    # circular distance on 1–12
    d = min((na - nb) % 12, (nb - na) % 12)
    flip = la != lb

    if d == 0 and not flip:
        kind, score = "same", 1.0
    elif d == 0 and flip:
        kind, score = "relative", 0.92
    elif d == 1 and not flip:
        kind, score = "adjacent", 0.88
    elif d == 1 and flip:
        kind, score = "diagonal", 0.55
    elif d == 2 and not flip:
        kind, score = "two_apart", 0.35
    else:
        kind, score = "clash", max(0.0, 0.25 - 0.05 * d)

    return {
        "kind": kind,
        "number_delta": d,
        "letter_flip": flip,
        "score": score,
    }


def tempo_compatibility(bpm_a: float, bpm_b: float, soft_pct: float = 6.0) -> dict:
    """
    Reward small tempo changes; allow ±6% as soft-compatible (beatmatchable),
    penalize larger jumps. Also check half/double-time as compatible.
    """
    if bpm_a <= 0 or bpm_b <= 0:
        return {"score": 0.5, "delta_pct": None, "half_double": False}

    ratios = [bpm_b / bpm_a, (2 * bpm_b) / bpm_a, bpm_b / (2 * bpm_a)]
    best_ratio = min(ratios, key=lambda r: abs(r - 1.0))
    half_double = best_ratio != ratios[0]
    delta_pct = abs(best_ratio - 1.0) * 100.0

    if delta_pct <= soft_pct:
        score = 1.0 - 0.15 * (delta_pct / soft_pct)
    elif delta_pct <= 12.0:
        score = 0.55 - 0.25 * ((delta_pct - soft_pct) / 6.0)
    else:
        score = max(0.05, 0.3 - 0.02 * (delta_pct - 12.0))

    return {
        "score": float(score),
        "delta_pct": float(delta_pct),
        "half_double": half_double,
    }
