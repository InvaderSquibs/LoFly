#!/usr/bin/env python3
"""
Aggregate optic-lobe column coverage from body-annotations feather →
fly_console/data/optic_lobe_hexmap.json.

Uses assignedOlHex1/assignedOlHex2 (axial q,r). In this annotation release
those columns are populated for lamina/medulla column types (L1, L2, Mi1, …)
but not for T4a — the explorer still shows T4a anatomy elsewhere; we default
to L1 and expose every type that actually has hex assignments.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
CONSOLE = Path(__file__).resolve().parents[1]
ANN = ROOT / "body-annotations-male-cns-v1.0-minconf-0.5.feather"
OUT = CONSOLE / "data" / "optic_lobe_hexmap.json"
PREFERRED_DEFAULT = "T4a"
FALLBACK_DEFAULT = "L1"


def main() -> None:
    ann = pd.read_feather(ANN)
    hexed = ann[
        ann["assignedOlHex1"].notna()
        & ann["assignedOlHex2"].notna()
        & (ann["superclass"] == "ol_intrinsic")
    ].copy()
    hexed["q"] = hexed["assignedOlHex1"].astype(int)
    hexed["r"] = hexed["assignedOlHex2"].astype(int)

    types: dict[str, dict] = {}
    for typ, sub in hexed.groupby("type"):
        g = (
            sub.groupby(["q", "r"], as_index=False)
            .size()
            .rename(columns={"size": "value"})
        )
        columns = [
            {"q": int(r.q), "r": int(r.r), "value": int(r.value)}
            for r in g.itertuples(index=False)
        ]
        types[str(typ)] = {
            "columns": columns,
            "n_neurons": int(len(sub)),
            "n_columns": len(columns),
            "value_kind": "neuron_count",
        }

    if PREFERRED_DEFAULT in types:
        default_type = PREFERRED_DEFAULT
        note = None
    else:
        default_type = FALLBACK_DEFAULT if FALLBACK_DEFAULT in types else sorted(types)[0]
        t4a_n = int((ann["type"] == PREFERRED_DEFAULT).sum())
        note = (
            f"{PREFERRED_DEFAULT} has {t4a_n} neurons in this release but none carry "
            f"assignedOlHex1/2; defaulting to {default_type} (types with column "
            f"assignments: {len(types)})."
        )

    payload = {
        "default_type": default_type,
        "types": types,
        "available_types": sorted(types.keys()),
        "note": note,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(
        f"Wrote {OUT} default={default_type} types={len(types)} "
        f"bytes={OUT.stat().st_size}"
    )
    if note:
        print("Note:", note)


if __name__ == "__main__":
    main()
