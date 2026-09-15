#!/usr/bin/env python3
"""
Bulk-fetch MaleCNS SWC skeletons for bodyIds used by the TTT edge set,
decimate each arbor with RDP (preserving branch points + leaves), and write
fly_console/data/neuron_skeletons.json.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]  # fly-brain/
CONSOLE = Path(__file__).resolve().parents[1]  # fly_console/
SWC_URL = (
    "https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/"
    "skeletons-malecns/skeletons-swc/{body_id}.swc"
)
CACHE_DIR = CONSOLE / "data" / "_swc_cache"
OUT_PATH = CONSOLE / "data" / "neuron_skeletons.json"

TARGET_MIN = 15
TARGET_MAX = 40
TARGET_NOM = 28
RDP_EPS0 = 1.5  # voxels
MAX_SIDE_BRANCHES = 4


def ordered_node_ids(nodes: pd.DataFrame) -> list[int]:
    """Match ttt_brain.py group ordering without importing brian2."""
    cell = [f"cell_{i}_" for i in range(9)]
    move = [f"move_{i}_" for i in range(9)]

    def full(prefix: str) -> str:
        matches = [g for g in nodes["group"].unique() if g.startswith(prefix)]
        if len(matches) != 1:
            raise RuntimeError(f"expected one group for {prefix}, got {matches}")
        return matches[0]

    cell_names = [full(p) for p in cell]
    move_names = [full(p) for p in move]
    other = [
        g
        for g in nodes["group"].unique()
        if g not in cell_names and g not in move_names
    ]
    order = cell_names + move_names + other
    ids: list[int] = []
    for g in order:
        ids.extend(sorted(nodes.loc[nodes["group"] == g, "bodyId"].tolist()))
    return ids


def edge_body_ids() -> list[int]:
    nodes = pd.read_feather(ROOT / "ttt_subgraph_nodes.feather").drop_duplicates(
        subset="bodyId"
    )
    ordered = ordered_node_ids(nodes)
    group_of = nodes.set_index("bodyId")["group"].to_dict()

    with open(ROOT / "ttt_3d_data.json") as f:
        d3 = json.load(f)
    located = sorted(int(k) for k in d3["positions"].keys())

    with open(ROOT / "ttt_edges_data.json") as f:
        ed = json.load(f)
    n_main = int(ed["n_main"])
    used = set()
    for e in ed["edges"]:
        used.add(int(e[0]))
        used.add(int(e[1]))
    main_pts = sorted(p for p in used if p < n_main)
    body_ids = [ordered[located[p]] for p in main_pts]
    return body_ids, {b: group_of.get(b, "other") for b in body_ids}


def parse_swc(text: str) -> dict[int, dict]:
    nodes: dict[int, dict] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 7:
            continue
        nid = int(parts[0])
        nodes[nid] = {
            "id": nid,
            "x": float(parts[2]),
            "y": float(parts[3]),
            "z": float(parts[4]),
            "parent": int(parts[6]),
        }
    return nodes


def build_children(nodes: dict[int, dict]) -> dict[int, list[int]]:
    children: dict[int, list[int]] = {nid: [] for nid in nodes}
    for nid, n in nodes.items():
        p = n["parent"]
        if p != -1 and p in children:
            children[p].append(nid)
    return children


def point_of(n: dict) -> tuple[float, float, float]:
    return (n["x"], n["y"], n["z"])


def dist_point_to_segment(
    p: tuple[float, float, float],
    a: tuple[float, float, float],
    b: tuple[float, float, float],
) -> float:
    ax, ay, az = a
    bx, by, bz = b
    px, py, pz = p
    abx, aby, abz = bx - ax, by - ay, bz - az
    apx, apy, apz = px - ax, py - ay, pz - az
    ab2 = abx * abx + aby * aby + abz * abz
    if ab2 < 1e-12:
        return math.sqrt(apx * apx + apy * apy + apz * apz)
    t = max(0.0, min(1.0, (apx * abx + apy * aby + apz * abz) / ab2))
    cx, cy, cz = ax + t * abx, ay + t * aby, az + t * abz
    dx, dy, dz = px - cx, py - cy, pz - cz
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def rdp(
    pts: list[tuple[float, float, float]], eps: float
) -> list[tuple[float, float, float]]:
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    max_d, idx = -1.0, -1
    for i in range(1, len(pts) - 1):
        d = dist_point_to_segment(pts[i], a, b)
        if d > max_d:
            max_d, idx = d, i
    if max_d > eps:
        left = rdp(pts[: idx + 1], eps)
        right = rdp(pts[idx:], eps)
        return left[:-1] + right
    return [a, b]


def path_length(nodes: dict[int, dict], chain: list[int]) -> float:
    s = 0.0
    for i in range(1, len(chain)):
        a, b = point_of(nodes[chain[i - 1]]), point_of(nodes[chain[i]])
        s += math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
    return s


def find_root(nodes: dict[int, dict]) -> int:
    roots = [
        nid
        for nid, n in nodes.items()
        if n["parent"] == -1 or n["parent"] not in nodes
    ]
    return roots[0] if roots else min(nodes)


def farthest_leaf_path(
    nodes: dict[int, dict], children: dict[int, list[int]], root: int
) -> list[int]:
    best: list[int] | None = None
    best_d = -1.0
    stack: list[tuple[int, list[int], float]] = [(root, [root], 0.0)]
    while stack:
        nid, path, d = stack.pop()
        kids = children.get(nid, [])
        if not kids:
            if d > best_d:
                best_d, best = d, path
            continue
        for k in kids:
            a, b = point_of(nodes[nid]), point_of(nodes[k])
            dd = math.sqrt(
                (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
            )
            stack.append((k, path + [k], d + dd))
    return best or [root]


def all_leaf_paths(
    nodes: dict[int, dict], children: dict[int, list[int]], root: int
) -> list[list[int]]:
    out: list[list[int]] = []
    stack: list[tuple[int, list[int]]] = [(root, [root])]
    while stack:
        nid, path = stack.pop()
        kids = children.get(nid, [])
        if not kids:
            out.append(path)
            continue
        for k in kids:
            stack.append((k, path + [k]))
    return out


def rdp_to_budget(
    pts: list[tuple[float, float, float]], budget: int
) -> tuple[list[tuple[float, float, float]], float]:
    """RDP with growing epsilon, then stride if still over budget."""
    if len(pts) <= budget:
        return pts, 0.0
    eps = RDP_EPS0
    simp = rdp(pts, eps)
    for _ in range(18):
        if len(simp) <= budget:
            break
        eps *= 1.55
        simp = rdp(pts, eps)
    if len(simp) > budget:
        step = max(1, math.ceil(len(simp) / budget))
        kept = simp[::step]
        if kept[-1] != simp[-1]:
            kept.append(simp[-1])
        simp = kept
    return simp, eps


def decimate_skeleton(nodes: dict[int, dict]) -> tuple[list[list[list[float]]], float]:
    """
    Keep the longest root→leaf path plus a few major side branches.
    Preserve branch points / leaves on those paths; RDP each run so the
    neuron lands near TARGET_NOM points total.

    Returns (polylines, max_eps_used). Spec allows a single flattened
    polyline; we keep separate polylines so the renderer does not draw
    false edges between branch tips.
    """
    if not nodes:
        return [], 0.0
    children = build_children(nodes)
    root = find_root(nodes)
    main = farthest_leaf_path(nodes, children, root)
    main_set = set(main)

    # Side branches: leaf paths that diverge from the main trunk.
    # Branch-point + leaf are preserved as endpoints of each side path.
    sides: list[tuple[float, list[int]]] = []
    for path in all_leaf_paths(nodes, children, root):
        i = 0
        while i < len(path) and path[i] in main_set:
            i += 1
        if i == 0 or i >= len(path):
            continue
        branch = [path[i - 1]] + path[i:]
        sides.append((path_length(nodes, branch), branch))
    sides.sort(reverse=True)
    pieces = [main] + [b for _, b in sides[:MAX_SIDE_BRANCHES]]

    lengths = [path_length(nodes, p) for p in pieces]
    total_l = sum(lengths) or 1.0
    budgets: list[int] = []
    remain = TARGET_NOM
    for i, L in enumerate(lengths):
        if i == len(lengths) - 1:
            budgets.append(max(3, remain))
        else:
            b = max(3, int(round(TARGET_NOM * L / total_l)))
            budgets.append(b)
            remain -= b

    polylines: list[list[list[float]]] = []
    max_eps = 0.0
    for path, budget in zip(pieces, budgets):
        pts = [point_of(nodes[i]) for i in path]
        simp, eps = rdp_to_budget(pts, budget)
        max_eps = max(max_eps, eps)
        polylines.append(
            [[round(x, 1), round(y, 1), round(z, 1)] for x, y, z in simp]
        )
    return polylines, max_eps


def adaptive_decimate(
    nodes: dict[int, dict],
) -> tuple[list[list[float]], list[list[list[float]]], int, float]:
    """Return (flat_points, polylines, raw_n, eps)."""
    raw_n = len(nodes)
    polylines, eps = decimate_skeleton(nodes)
    flat: list[list[float]] = [p for poly in polylines for p in poly]
    # If still outside band, nudge budgets via re-RDP on flat main only.
    n = sum(len(p) for p in polylines)
    if n > TARGET_MAX and polylines:
        scale = TARGET_MAX / n
        new_polys = []
        for poly in polylines:
            budget = max(3, int(round(len(poly) * scale)))
            pts = [(p[0], p[1], p[2]) for p in poly]
            simp, e2 = rdp_to_budget(pts, budget)
            eps = max(eps, e2)
            new_polys.append(
                [[round(x, 1), round(y, 1), round(z, 1)] for x, y, z in simp]
            )
        polylines = new_polys
        flat = [p for poly in polylines for p in poly]
    return flat, polylines, raw_n, eps


def fetch_swc(body_id: int, timeout: float = 60.0) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{body_id}.swc"
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return cache_path.read_text(encoding="utf-8", errors="replace")
    url = SWC_URL.format(body_id=body_id)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            data = resp.read()
        cache_path.write_bytes(data)
        return data.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except Exception as e:
        print(f"  WARN fetch {body_id}: {e}", file=sys.stderr)
        return None


def process_one(body_id: int) -> tuple[int, dict | None, str]:
    text = fetch_swc(body_id)
    if text is None:
        return body_id, None, "missing"
    nodes = parse_swc(text)
    if not nodes:
        return body_id, None, "empty"
    flat, polylines, raw_n, eps = adaptive_decimate(nodes)
    kept = sum(len(p) for p in polylines)
    return (
        body_id,
        {
            "points": flat,
            "polylines": polylines,
            "_raw": raw_n,
            "_eps": eps,
            "_kept": kept,
        },
        "ok",
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--limit", type=int, default=0, help="debug: only first N bodyIds")
    ap.add_argument("--probe", action="store_true", help="HEAD one SWC and exit")
    args = ap.parse_args()

    probe_url = SWC_URL.format(body_id=10975)
    print(f"Probing {probe_url} …")
    req = urllib.request.Request(probe_url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            code = getattr(resp, "status", 200)
            print(f"  HEAD status {code}, length={resp.headers.get('Content-Length')}")
            if code == 403:
                print("Bucket returned 403 — stopping as requested.")
                sys.exit(2)
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print("Bucket returned 403 — stopping as requested.")
            sys.exit(2)
        raise

    if args.probe:
        return

    body_ids, groups = edge_body_ids()
    if args.limit:
        body_ids = body_ids[: args.limit]
    print(f"Fetching/decimating {len(body_ids)} neurons with {args.workers} workers…")

    out: dict[str, dict] = {}
    missing = 0
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_one, b): b for b in body_ids}
        for fut in as_completed(futs):
            bid, payload, status = fut.result()
            done += 1
            if status != "ok" or payload is None:
                missing += 1
            else:
                raw, kept, eps = payload.pop("_raw"), payload.pop("_kept"), payload.pop("_eps")
                payload["group"] = groups.get(bid, "other")
                out[str(bid)] = payload
                if done <= 8 or done % 200 == 0 or done == len(body_ids):
                    print(
                        f"  [{done}/{len(body_ids)}] bodyId={bid} "
                        f"{raw}→{kept} pts (eps={eps:.2f})"
                    )
            if done % 100 == 0:
                rate = done / max(1e-6, time.time() - t0)
                print(f"  … {done}/{len(body_ids)} ({rate:.1f}/s)")

    kept_counts = [
        sum(len(p) for p in v.get("polylines") or [v.get("points") or []])
        for v in out.values()
    ]
    if kept_counts:
        print(
            f"Compression: n={len(kept_counts)} mean_pts={sum(kept_counts)/len(kept_counts):.1f} "
            f"min={min(kept_counts)} max={max(kept_counts)} missing={missing}"
        )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes) in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
