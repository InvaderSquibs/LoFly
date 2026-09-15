"""
Catalogue every track in LoFly's library with librosa features.

Extracts (per track):
  - duration, RMS energy, tempo (BPM)
  - mean + std 12-D chroma (CQT)
  - estimated key (pitch class + major/minor) → Camelot code
  - spectral centroid / bandwidth / rolloff means
  - onset density

Checkpointed: writes catalogue.json after each track so long runs resume.

  cd fly_console && python3 activities/lofly/catalogue.py
  cd fly_console && python3 activities/lofly/catalogue.py --limit 5   # smoke test
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ACTIVITY_DIR = Path(__file__).resolve().parent
LIBRARY_DIR = ACTIVITY_DIR / "library"
OUT_PATH = ACTIVITY_DIR / "catalogue.json"

# Major / minor key profiles (Krumhansl-Kessler), pitch class C=0
_MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)


def _estimate_key(chroma_mean: np.ndarray) -> tuple[int, str, float]:
    """Return (pitch_class, mode, correlation)."""
    from camelot import PITCH_NAMES  # local package

    best = (-1, "minor", -1.0)
    x = chroma_mean / (chroma_mean.sum() + 1e-9)
    for shift in range(12):
        rotated = np.roll(x, -shift)
        for mode, profile in (("major", _MAJOR_PROFILE), ("minor", _MINOR_PROFILE)):
            p = profile / profile.sum()
            corr = float(np.corrcoef(rotated, p)[0, 1])
            if corr > best[2]:
                best = (shift, mode, corr)
    return best[0], best[1], best[2]


def analyze_track(path: Path, sr: int = 22050) -> dict:
    import librosa
    from camelot import PITCH_NAMES, key_to_camelot

    y, sr = librosa.load(str(path), sr=sr, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # Tempo
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo = float(librosa.feature.tempo(onset_envelope=onset_env, sr=sr)[0])
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
    onset_density = float(len(onset_frames) / max(duration, 1e-6))

    # Chroma timeline at 0.2s — real slices along the song, not a handful of landmarks
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    chroma_std = chroma.std(axis=1)

    slice_sec = 0.2
    n_frames = chroma.shape[1]
    times = np.arange(0.0, duration, slice_sec)
    if len(times) == 0 or float(times[-1]) < duration - 1e-9:
        times = np.append(times, duration)
    frame_times = librosa.frames_to_time(np.arange(n_frames), sr=sr)
    idxs = np.clip(np.searchsorted(frame_times, times, side="left"), 0, n_frames - 1)
    chroma_timeline = [chroma[:, int(i)].tolist() for i in idxs]

    pitch_class, mode, key_corr = _estimate_key(chroma_mean)
    camelot = key_to_camelot(pitch_class, mode)

    # Spectral
    cent = librosa.feature.spectral_centroid(y=y, sr=sr)
    bw = librosa.feature.spectral_bandwidth(y=y, sr=sr)
    rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)
    rms = librosa.feature.rms(y=y)

    title = path.stem
    if title.lower().startswith("fuzzywave "):
        title = title[len("fuzzywave ") :]
    title = title.strip(" .-_")

    return {
        "id": path.name,
        "path": str(path.relative_to(ACTIVITY_DIR)),
        "title": title,
        "duration_s": round(duration, 2),
        "bpm": round(tempo, 2),
        "key_pitch_class": int(pitch_class),
        "key_name": PITCH_NAMES[pitch_class],
        "key_mode": mode,
        "key_confidence": round(float(key_corr), 4),
        "camelot": camelot,
        "chroma_mean": [round(float(x), 5) for x in chroma_mean],
        "chroma_std": [round(float(x), 5) for x in chroma_std],
        "chroma_timeline": [[round(float(v), 4) for v in row] for row in chroma_timeline],
        "spectral_centroid_hz": round(float(cent.mean()), 2),
        "spectral_bandwidth_hz": round(float(bw.mean()), 2),
        "spectral_rolloff_hz": round(float(rolloff.mean()), 2),
        "rms_mean": round(float(rms.mean()), 5),
        "onset_density_hz": round(onset_density, 4),
    }


def load_catalogue() -> dict:
    if OUT_PATH.exists():
        with open(OUT_PATH) as f:
            return json.load(f)
    return {"tracks": {}, "meta": {"n_tracks": 0}}


def save_catalogue(cat: dict) -> None:
    cat["meta"] = {
        "n_tracks": len(cat["tracks"]),
        "library": str(LIBRARY_DIR.relative_to(ACTIVITY_DIR)),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    tmp = OUT_PATH.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(cat, f, indent=2)
    tmp.replace(OUT_PATH)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Max new tracks this run")
    parser.add_argument("--force", action="store_true", help="Re-analyze existing ids")
    args = parser.parse_args()

    sys.path.insert(0, str(ACTIVITY_DIR))

    files = sorted(LIBRARY_DIR.glob("*.mp3"))
    if not files:
        print(f"No mp3s in {LIBRARY_DIR}", file=sys.stderr)
        sys.exit(1)

    cat = load_catalogue()
    done = 0
    for path in files:
        tid = path.name
        if tid in cat["tracks"] and not args.force:
            continue
        t0 = time.time()
        try:
            feat = analyze_track(path)
        except Exception as e:
            print(f"FAIL {tid}: {e}", file=sys.stderr)
            continue
        cat["tracks"][tid] = feat
        save_catalogue(cat)
        done += 1
        print(
            f"[{done}] {feat['title'][:50]!r}  "
            f"{feat['camelot']}  {feat['bpm']:.1f}bpm  "
            f"{feat['duration_s']:.0f}s  ({time.time() - t0:.1f}s)"
        )
        if args.limit and done >= args.limit:
            break

    print(f"Catalogue: {len(cat['tracks'])} / {len(files)} tracks → {OUT_PATH}")


if __name__ == "__main__":
    main()
