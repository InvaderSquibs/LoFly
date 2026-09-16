#!/usr/bin/env python3
"""
FS-Avatar — real Battlesnake webhook (not a stub).

Endpoints (Battlesnake API):
  GET  /           → appearance
  POST /start      → game start
  POST /move       → {"move","shout"}  (also stores board for the console)
  POST /end        → game end

Dev helpers for the fly console:
  GET  /dev/status → health + last decision
  GET  /dev/last   → last /move request + decision (CORS)
  POST /dev/play   → spawn `battlesnake play` against this server

  python3 server.py
  # then from another terminal, or via the console "Start game" button:
  battlesnake play -W 11 -H 11 --name Walton-FS --url http://127.0.0.1:8001 -g solo -v
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import dials as dials_mod
import game_log

PORT = int(os.environ.get("PORT") or os.environ.get("FS_AVATAR_PORT", "8001"))
AUTHOR = os.environ.get("FS_AVATAR_AUTHOR", "Walton")
COLOR = os.environ.get("FS_AVATAR_COLOR", "#141414")
HEAD = os.environ.get("FS_AVATAR_HEAD", "bee")
TAIL = os.environ.get("FS_AVATAR_TAIL", "bee")
SNAKE_NAME = os.environ.get("FS_AVATAR_NAME", "Walton-LoFly-v0.1")

MOVES = ("up", "down", "left", "right")
DELTA = {
    "up": (0, 1),
    "down": (0, -1),
    "left": (-1, 0),
    "right": (1, 0),
}
OPPOSITE = {"up": "down", "down": "up", "left": "right", "right": "left"}

_lock = threading.Lock()
_last: Dict[str, Any] = {
    "updated_at": None,
    "phase": "idle",  # idle | start | move | end | playing
    "game_id": None,
    "turn": None,
    "decision": None,
    "request": None,
    "play": None,
}
_play_proc: Optional[subprocess.Popen] = None
_frames: List[Dict[str, Any]] = []  # theater queue — every /move so console never skips turns
_frame_seq = 0
_FRAME_CAP = 800


def _set_last(**kwargs: Any) -> None:
    with _lock:
        _last.update(kwargs)
        _last["updated_at"] = time.time()


def _get_last() -> Dict[str, Any]:
    with _lock:
        return json.loads(json.dumps(_last))


def _push_frame(frame: Dict[str, Any]) -> None:
    """Append a theater frame (start/move/end). Console drains via GET /dev/frames."""
    global _frame_seq
    with _lock:
        _frame_seq += 1
        entry = dict(frame)
        entry["seq"] = _frame_seq
        entry["queued_at"] = time.time()
        _frames.append(entry)
        if len(_frames) > _FRAME_CAP:
            del _frames[: len(_frames) - _FRAME_CAP]


def _take_frames(n: int = 16) -> Dict[str, Any]:
    with _lock:
        n = max(1, min(int(n), 64))
        taken = _frames[:n]
        del _frames[:n]
        # shallow copy so callers can mutate freely
        return {
            "frames": [dict(f) for f in taken],
            "pending": len(_frames),
            "seq": _frame_seq,
        }


def _clear_frames() -> None:
    with _lock:
        _frames.clear()


def _key(p: Dict[str, int]) -> Tuple[int, int]:
    return (int(p["x"]), int(p["y"]))


def _add(p: Dict[str, int], d: Tuple[int, int]) -> Dict[str, int]:
    return {"x": p["x"] + d[0], "y": p["y"] + d[1]}


def _manhattan(a: Dict[str, int], b: Dict[str, int]) -> int:
    return abs(a["x"] - b["x"]) + abs(a["y"] - b["y"])


def _last_move(snake: Dict[str, Any]) -> Optional[str]:
    body = snake.get("body") or []
    if len(body) < 2:
        return None
    h, n = body[0], body[1]
    dx, dy = h["x"] - n["x"], h["y"] - n["y"]
    if dx == 1:
        return "right"
    if dx == -1:
        return "left"
    if dy == 1:
        return "up"
    if dy == -1:
        return "down"
    return None


def _in_bounds(board: Dict[str, Any], p: Dict[str, int]) -> bool:
    return 0 <= p["x"] < board["width"] and 0 <= p["y"] < board["height"]


def _blocked(board: Dict[str, Any], you: Dict[str, Any]) -> set:
    blocked = set()
    for snake in board.get("snakes") or []:
        body = snake.get("body") or []
        end = len(body) - 1 if snake.get("id") == you.get("id") and len(body) > 1 else len(body)
        for i in range(end):
            blocked.add(_key(body[i]))
    for h in board.get("hazards") or []:
        blocked.add(_key(h))
    head = you.get("head") or (you.get("body") or [{}])[0]
    blocked.discard(_key(head))
    return blocked


def _blocked_after_move(
    board: Dict[str, Any],
    you: Dict[str, Any],
    nxt: Dict[str, int],
    grow: bool,
) -> set:
    """Occupied cells after we step to nxt. Current head stays filled (becomes neck).
    Own tip frees only when we are not growing — critical for pocket flood accuracy.
    """
    blocked: set = set()
    you_id = you.get("id")
    for snake in board.get("snakes") or []:
        body = snake.get("body") or []
        if not body:
            continue
        if snake.get("id") == you_id:
            # Keep every segment including head; drop tip only if not growing.
            last = len(body) if grow or len(body) <= 1 else len(body) - 1
            for i in range(last):
                blocked.add(_key(body[i]))
        else:
            for p in body:
                blocked.add(_key(p))
    for h in board.get("hazards") or []:
        blocked.add(_key(h))
    # Destination is vacated for flood start.
    blocked.discard(_key(nxt))
    return blocked


def _min_self_body_dist(cell: Dict[str, int], you: Dict[str, Any], skip_tip: bool = True) -> float:
    """Distance to own body (not head). Used to penalize hugging our coil."""
    body = you.get("body") or []
    if len(body) < 2:
        return float("inf")
    end = len(body) - 1 if skip_tip and len(body) > 1 else len(body)
    best = float("inf")
    for i in range(1, end):  # skip head at 0
        best = min(best, _manhattan(cell, body[i]))
    return best if math.isfinite(best) else float("inf")


def _body_after_move(you: Dict[str, Any], nxt: Dict[str, int], grow: bool) -> List[Dict[str, int]]:
    body = [dict(p) for p in (you.get("body") or [])]
    new_body = [dict(nxt)] + body
    if not grow and len(new_body) > 1:
        new_body = new_body[:-1]
    return new_body


def _followup_max_space(
    board: Dict[str, Any], you: Dict[str, Any], nxt: Dict[str, int], grow: bool
) -> int:
    """Best flood after one more step from nxt — catches 1-ply choke entries."""
    new_body = _body_after_move(you, nxt, grow)
    you2: Dict[str, Any] = {
        "id": you.get("id"),
        "body": new_body,
        "head": dict(nxt),
        "length": len(new_body),
    }
    snakes = []
    for s in board.get("snakes") or []:
        snakes.append(you2 if s.get("id") == you.get("id") else s)
    board2 = {
        "width": board["width"],
        "height": board["height"],
        "food": board.get("food") or [],
        "hazards": board.get("hazards") or [],
        "snakes": snakes,
    }
    neck2 = _last_move(you2)
    # Occupied after first move (tip already handled in new_body).
    occ: set = set()
    for s in snakes:
        for p in s.get("body") or []:
            occ.add(_key(p))
    for h in board2.get("hazards") or []:
        occ.add(_key(h))
    # Tip of you2 will free on second non-grow step.
    tip_k = _key(new_body[-1]) if len(new_body) > 1 else None
    best = 0
    for m in MOVES:
        if neck2 and m == OPPOSITE.get(neck2):
            continue
        n2 = _add(nxt, DELTA[m])
        if not _in_bounds(board2, n2):
            continue
        k2 = _key(n2)
        if k2 in occ and k2 != tip_k:
            continue
        blocked2 = _blocked_after_move(board2, you2, n2, grow=False)
        sp = _flood(board2, n2, blocked2)
        if sp > best:
            best = sp
    return best


def _flood(board: Dict[str, Any], start: Dict[str, int], blocked: set) -> int:
    if not _in_bounds(board, start) or _key(start) in blocked:
        return 0
    seen = {_key(start)}
    q = [start]
    n = 0
    while q:
        cur = q.pop(0)
        n += 1
        for move in MOVES:
            nxt = _add(cur, DELTA[move])
            k = _key(nxt)
            if k in seen or not _in_bounds(board, nxt) or k in blocked:
                continue
            seen.add(k)
            q.append(nxt)
    return n


def _nearest_food(head: Dict[str, int], food: List[Dict[str, int]]) -> Optional[int]:
    if not food:
        return None
    return min(_manhattan(head, f) for f in food)


def _min_snake_danger(head: Dict[str, int], board: Dict[str, Any], you: Dict[str, Any]) -> float:
    """Distance to rival bodies/heads only — food should smell, not 'see' walls as fruit veto."""
    best = float("inf")
    for snake in board.get("snakes") or []:
        if snake.get("id") == you.get("id"):
            continue
        for p in snake.get("body") or []:
            best = min(best, _manhattan(head, p))
    if not math.isfinite(best):
        best = float(max(board["width"], board["height"]))
    return best


def _min_danger(head: Dict[str, int], board: Dict[str, Any], you: Dict[str, Any]) -> float:
    best = _min_snake_danger(head, board, you)
    d = dials_mod.load_dials()
    if d.get("wall_counts_as_danger", True):
        wall = min(
            head["x"],
            head["y"],
            board["width"] - 1 - head["x"],
            board["height"] - 1 - head["y"],
        )
        best = min(best, wall + 0.5)
    if not math.isfinite(best):
        best = float(max(board["width"], board["height"]))
    return best


def _velocity_threat(
    cell: Dict[str, int],
    board: Dict[str, Any],
    you: Dict[str, Any],
    dials: Optional[Dict[str, Any]] = None,
) -> float:
    d = dials or dials_mod.load_dials()
    threat = 0.0
    my_len = you.get("length") or len(you.get("body") or [])
    eq_threat = float(d.get("equal_or_longer_head_threat", 4.0))
    short_threat = float(d.get("shorter_head_threat", 0.4))
    for snake in board.get("snakes") or []:
        if snake.get("id") == you.get("id"):
            continue
        head = snake.get("head") or (snake.get("body") or [None])[0]
        if not head:
            continue
        vel = _last_move(snake)
        if vel:
            projected = _add(head, DELTA[vel])
            if _key(projected) == _key(cell):
                threat += 2.5
            if _manhattan(projected, cell) == 1:
                threat += 1.2
        if _manhattan(head, cell) == 1:
            their = snake.get("length") or len(snake.get("body") or [])
            threat += eq_threat if their >= my_len else short_threat
    return threat


def _forward_cone_empty(
    board: Dict[str, Any], head: Dict[str, int], facing: str, blocked: set
) -> Dict[str, Any]:
    """Empty cells in a forward-facing cone (egocentric, matches hex-eye frame)."""
    face = facing if facing in DELTA else "up"
    fwd = DELTA[face]  # (dx, dy)
    # right = rotate forward 90° clockwise in board coords
    right = (fwd[1], -fwd[0])
    depth = max(3, min(board["width"], board["height"]) - 1)
    empty = 0
    capacity = 0
    for d in range(1, depth + 1):
        half = d
        for lat in range(-half, half + 1):
            capacity += 1
            p = {
                "x": head["x"] + d * fwd[0] + lat * right[0],
                "y": head["y"] + d * fwd[1] + lat * right[1],
            }
            if not _in_bounds(board, p):
                continue
            if _key(p) in blocked:
                continue
            empty += 1
    return {
        "empty": empty,
        "capacity": capacity,
        "ratio": (empty / capacity) if capacity else 0.0,
        "facing": face,
        "depth": depth,
    }


def _relative_size(board: Dict[str, Any], you: Dict[str, Any]) -> Dict[str, Any]:
    my_len = int(you.get("length") or len(you.get("body") or []) or 1)
    max_rival = 0
    sum_rival = 0
    n_rival = 0
    for snake in board.get("snakes") or []:
        if snake.get("id") == you.get("id"):
            continue
        length = int(snake.get("length") or len(snake.get("body") or []) or 0)
        if length <= 0:
            continue
        n_rival += 1
        sum_rival += length
        if length > max_rival:
            max_rival = length
    avg_rival = (sum_rival / n_rival) if n_rival else 0.0
    if n_rival:
        vs_max = (my_len - max_rival) / max(my_len, max_rival, 1)
    else:
        vs_max = 1.0
    size_advantage = max(0.0, min(1.0, (vs_max + 1.0) / 2.0))
    longest = (not n_rival) or my_len > max_rival
    size_lead = ((my_len - max_rival) / my_len) if (n_rival and my_len > max_rival) else 0.0
    return {
        "length_you": my_len,
        "length_max_rival": max_rival,
        "length_avg_rival": avg_rival,
        "rivals": n_rival,
        "size_advantage": size_advantage,
        "longest": longest,
        "size_lead": size_lead,
    }


def _food_courtship_targets(
    board: Dict[str, Any], you: Dict[str, Any], head: Dict[str, int]
) -> Dict[str, Any]:
    """Prefer fruit rivals are not racing toward — exclusivity drives courtship."""
    foods = board.get("food") or []
    if not foods:
        return {
            "preferred": None,
            "exclusivity": 1.0,
            "contested": False,
            "myDist": None,
            "rivalsCloser": 0.0,
            "rivalsHeading": 0.0,
            "ranked": [],
        }
    foes = [s for s in (board.get("snakes") or []) if s.get("id") != you.get("id")]
    ranked: List[Dict[str, Any]] = []
    for food in foods:
        my_dist = _manhattan(head, food)
        rivals_closer = 0.0
        rivals_heading = 0.0
        for snake in foes:
            fh = snake.get("head") or (snake.get("body") or [None])[0]
            if not fh:
                continue
            their_dist = _manhattan(fh, food)
            if their_dist < my_dist:
                rivals_closer += 1.0
            elif their_dist == my_dist:
                rivals_closer += 0.5
            vel = _last_move(snake)
            if vel:
                proj = _add(fh, DELTA[vel])
                if _manhattan(proj, food) < their_dist:
                    rivals_heading += 1.0
        contest = rivals_closer + 0.8 * rivals_heading
        exclusivity = 1.0 / (1.0 + contest)
        value = exclusivity * (1.0 / (1.0 + my_dist)) * (0.7 + 0.6 * exclusivity)
        ranked.append(
            {
                "food": food,
                "myDist": my_dist,
                "contest": contest,
                "exclusivity": exclusivity,
                "value": value,
                "rivalsCloser": rivals_closer,
                "rivalsHeading": rivals_heading,
            }
        )
    ranked.sort(key=lambda r: r["value"], reverse=True)
    best = ranked[0]
    return {
        "preferred": best["food"],
        "exclusivity": best["exclusivity"],
        "contested": best["contest"] >= 1.0,
        "myDist": best["myDist"],
        "rivalsCloser": best["rivalsCloser"],
        "rivalsHeading": best["rivalsHeading"],
        "ranked": ranked,
    }


def _orchard_scent(board: Dict[str, Any], head: Dict[str, int]) -> Dict[str, Any]:
    """Proximity-weighted food pockets + attractor cell the snake steers toward."""
    foods = board.get("food") or []
    if not foods or not head:
        return {
            "foodCount": 0,
            "abundance": 0.0,
            "smell": 0.0,
            "scentHere": 0.0,
            "target": None,
            "clusterMass": 0.0,
        }

    tau = 2.5

    def scent_at(p: Dict[str, int]) -> float:
        return sum(math.exp(-_manhattan(p, f) / tau) for f in foods)

    best_food = foods[0]
    best_score = -1e9
    best_mass = 0.0
    for f in foods:
        mass = sum(math.exp(-_manhattan(f, g) / 2.0) for g in foods)
        score = mass / (1.0 + _manhattan(head, f))
        if score > best_score:
            best_score = score
            best_food = f
            best_mass = mass

    wx = wy = wsum = 0.0
    for f in foods:
        d = _manhattan(best_food, f)
        if d > 4:
            continue
        w = math.exp(-d / 2.0)
        wx += w * f["x"]
        wy += w * f["y"]
        wsum += w
    target = (
        {"x": int(round(wx / wsum)), "y": int(round(wy / wsum))}
        if wsum > 0
        else {"x": best_food["x"], "y": best_food["y"]}
    )

    scent_here = scent_at(head)
    abundance = max(0.0, min(1.0, 1.0 - math.exp(-len(foods) / 2.2)))
    smell = max(
        0.0,
        min(
            1.0,
            0.4 * abundance
            + 0.6 * min(1.0, scent_here / max(1.2, len(foods) * 0.45)),
        ),
    )
    return {
        "foodCount": len(foods),
        "abundance": abundance,
        "smell": smell,
        "scentHere": scent_here,
        "target": target,
        "clusterMass": best_mass,
        "scent_at": scent_at,
    }


def _food_race_or_yield(
    board: Dict[str, Any], you: Dict[str, Any], head: Dict[str, int], size: Dict[str, Any]
) -> Dict[str, Any]:
    """Race only with a real length lead + uncontested fruit; no equal-length race_force."""
    base = _food_courtship_targets(board, you, head)
    ranked = base.get("ranked") or []
    if not ranked:
        out = dict(base)
        out.update(mode="none", race=False)
        return out
    can_race = (
        int(size.get("length_you") or 0) > int(size.get("length_max_rival") or 0)
        and (float(size.get("size_advantage") or 0) >= 0.55 or float(size.get("size_lead") or 0) > 0)
    )
    if can_race:
        raceable = sorted(
            [r for r in ranked if r["rivalsCloser"] < 1],
            key=lambda r: (r["myDist"], -r["exclusivity"]),
        )
        if raceable:
            pick = raceable[0]
            return {
                "preferred": pick["food"],
                "exclusivity": pick["exclusivity"],
                "contested": pick["contest"] >= 1.0,
                "myDist": pick["myDist"],
                "rivalsCloser": pick["rivalsCloser"],
                "rivalsHeading": pick["rivalsHeading"],
                "ranked": ranked,
                "mode": "race",
                "race": True,
            }
        out = dict(base)
        out.update(mode="yield_contested", race=False)
        return out
    out = dict(base)
    out.update(mode="yield", race=False)
    return out


def _region_entropy(
    board: Dict[str, Any], head: Dict[str, int], facing: str, blocked: set
) -> Dict[str, Any]:
    """Mobility + cone openness + fruit-in-cone — higher = more options ahead."""
    face = facing if facing in DELTA else "up"
    cone = _forward_cone_empty(board, head, face, blocked)
    space = _flood(board, head, blocked)
    board_area = max(1, board["width"] * board["height"])
    mobility = math.log(1 + space) / math.log(1 + board_area)
    foods = board.get("food") or []
    food_in_cone = 0
    if foods and cone["capacity"]:
        fwd = DELTA[face]
        right = (fwd[1], -fwd[0])
        depth = int(cone.get("depth") or max(3, min(board["width"], board["height"]) - 1))
        food_set = {_key(f) for f in foods}
        for d in range(1, depth + 1):
            for lat in range(-d, d + 1):
                p = {
                    "x": head["x"] + d * fwd[0] + lat * right[0],
                    "y": head["y"] + d * fwd[1] + lat * right[1],
                }
                if _key(p) in food_set:
                    food_in_cone += 1
    fruit = (food_in_cone / len(foods)) if foods else 0.0
    open_ratio = float(cone["ratio"])
    entropy = max(0.0, min(1.0, 0.5 * mobility + 0.3 * open_ratio + 0.2 * fruit))
    return {
        "entropy": entropy,
        "mobility": mobility,
        "open": open_ratio,
        "fruit": fruit,
        "foodInCone": food_in_cone,
        "space": space,
        "facing": face,
    }


def _facing_axes(facing: str) -> Tuple[str, Tuple[int, int], Tuple[int, int]]:
    face = facing if facing in DELTA else "up"
    fwd = DELTA[face]
    right = (fwd[1], -fwd[0])
    return face, fwd, right


def _build_retina(board: Dict[str, Any], you: Dict[str, Any], facing: str) -> Dict[str, Any]:
    """Egocentric 4-channel field: open / fruit / threat / self + cone mask."""
    head = you.get("head") or you["body"][0]
    face, fwd, right = _facing_axes(facing)
    depth = max(3, min(board["width"], board["height"]) - 1)
    food_set = {_key(f) for f in (board.get("food") or [])}
    you_set = {_key(p) for p in (you.get("body") or [])}
    my_len = int(you.get("length") or len(you.get("body") or []) or 1)
    threat_map: Dict[str, float] = {}
    for snake in board.get("snakes") or []:
        if snake.get("id") == you.get("id"):
            continue
        length = int(snake.get("length") or len(snake.get("body") or []) or 1)
        hot = 0.6 + 0.4 * min(1.0, length / max(my_len, 1))
        body = snake.get("body") or []
        for i, p in enumerate(body):
            w = (1.6 if i == 0 else 0.7) * hot
            k = _key(p)
            threat_map[k] = max(threat_map.get(k, 0.0), w)
    cells: List[Dict[str, Any]] = []
    for d in range(0, depth + 1):
        for lat in range(-d, d + 1):
            if d == 0 and lat != 0:
                continue
            p = {
                "x": head["x"] + d * fwd[0] + lat * right[0],
                "y": head["y"] + d * fwd[1] + lat * right[1],
            }
            inb = _in_bounds(board, p)
            k = _key(p)
            in_cone = d >= 1 and abs(lat) <= d
            open_v = 0.0
            fruit = 0.0
            threat = 0.0
            self_v = 0.0
            if not inb:
                threat = 0.35
            else:
                if k in you_set:
                    self_v = 1.0
                if k in food_set:
                    fruit = 1.0
                if k in threat_map:
                    threat = threat_map[k]
                if not self_v and threat < 0.5:
                    open_v = 0.8 if fruit else 1.0
            cells.append(
                {
                    "d": d,
                    "lat": lat,
                    "p": p,
                    "inb": inb,
                    "inCone": in_cone,
                    "open": open_v,
                    "fruit": fruit,
                    "threat": threat,
                    "self": self_v,
                }
            )
    return {"facing": face, "depth": depth, "cells": cells, "fwd": fwd, "right": right}


def _sample_sectors(retina: Dict[str, Any]) -> Dict[str, Any]:
    cells = retina.get("cells") or []

    def bag(pred) -> Dict[str, float]:
        n = 0
        open_s = fruit_s = threat_s = self_s = 0.0
        for c in cells:
            if not pred(c):
                continue
            n += 1
            open_s += c["open"]
            fruit_s += c["fruit"]
            threat_s += c["threat"]
            self_s += c["self"]
        inv = (1.0 / n) if n else 0.0
        o = open_s * inv
        f = fruit_s * inv
        t = min(1.0, threat_s * inv * 2.0)
        entropy = max(0.0, min(1.0, 0.65 * o + 0.35 * min(1.0, fruit_s / max(1.0, n * 0.12))))
        return {"n": n, "open": o, "fruit": f, "threat": t, "self": self_s * inv, "entropy": entropy}

    forward = bag(lambda c: c["d"] >= 1 and abs(c["lat"]) <= max(1, int(c["d"] * 0.45)))
    left = bag(lambda c: c["d"] >= 1 and c["lat"] < 0 and abs(c["lat"]) <= c["d"])
    right = bag(lambda c: c["d"] >= 1 and c["lat"] > 0 and abs(c["lat"]) <= c["d"])
    near = bag(lambda c: 1 <= c["d"] <= 2)
    cone = bag(lambda c: c["inCone"] and c["d"] >= 1)
    open_v = 0.55 * forward["open"] + 0.15 * left["open"] + 0.15 * right["open"] + 0.15 * near["open"]
    fruit = 0.6 * forward["fruit"] + 0.15 * left["fruit"] + 0.15 * right["fruit"] + 0.1 * near["fruit"]
    threat = (
        0.35 * forward["threat"] + 0.15 * left["threat"] + 0.15 * right["threat"] + 0.35 * near["threat"]
    )
    entropy = max(
        0.0,
        min(1.0, 0.5 * forward["entropy"] + 0.2 * cone["entropy"] + 0.3 * (0.65 * open_v + 0.35 * fruit)),
    )
    return {
        "forward": forward,
        "left": left,
        "right": right,
        "near": near,
        "cone": cone,
        "open": open_v,
        "fruit": fruit,
        "threat": threat,
        "entropy": entropy,
    }


def decide(game_state: Dict[str, Any]) -> Dict[str, Any]:
    board = game_state["board"]
    you = game_state["you"]
    head = you.get("head") or you["body"][0]
    neck = _last_move(you)
    facing = neck or "up"
    blocked = _blocked(board, you)
    health_hunger = max(0.0, min(1.0, (100 - float(you.get("health", 100))) / 100.0))
    hunger = max(0.92, health_hunger)
    danger_now = _min_danger(head, board, you)
    max_dim = float(max(board["width"], board["height"]))
    size = _relative_size(board, you)
    cone = _forward_cone_empty(board, head, facing, blocked)
    safety = max(0.0, min(1.0, float(cone["ratio"])))
    food_target = _food_race_or_yield(board, you, head, size)
    here_entropy = _region_entropy(board, head, facing, blocked)
    here_sectors = _sample_sectors(_build_retina(board, you, facing))
    courtship = (
        (safety ** 1.05)
        * (0.35 + 0.3 * min(1.0, danger_now / (max_dim * 0.4)))
        * (0.4 + 0.35 * food_target["exclusivity"] + 0.25 * here_entropy["entropy"])
    )
    d = dials_mod.load_dials()
    aggression = 0.5 + 0.5 * size["size_advantage"]
    turn = int(game_state.get("turn") or 0)
    early = turn < int(d.get("early_game_turns", 0) or 0)
    if early:
        aggression = min(aggression, float(d.get("early_aggression_cap", aggression)))
    # wiring from dials — spatial scent pocket + attractor
    health = float(you.get("health", 100))
    starve_urgency = max(0.0, min(1.0, (55.0 - health) / 55.0))
    food_dist_now = (
        food_target["myDist"]
        if food_target["myDist"] is not None
        else _nearest_food(head, board.get("food") or [])
    )
    # Panic must be rare: OR(danger<=1) fired whenever SmartyTree's body was adjacent,
    # locking fly into escape for ~60% of Rung4 games and starving growth/courtship.
    snake_near = _min_snake_danger(head, board, you)
    tunnel_thresh = float(d.get("panic_tunnel_thresh", 0.08))
    panic = (
        (
            (safety < float(d["panic_safety_thresh"]) and snake_near <= float(d["panic_danger_thresh"]))
            or safety < tunnel_thresh
        )
        and starve_urgency < float(d["starve_blocks_panic_above"])
    )
    undersized = size["size_advantage"] < 0.5
    dominant = size["size_advantage"] >= 0.55 or bool(size.get("longest"))
    len_gap = int(size.get("length_max_rival") or 0) - int(size.get("length_you") or 0)
    behind = len_gap >= int(d.get("catchup_len_gap", 2) or 2)
    orchard = _orchard_scent(board, head)
    food_count = int(orchard["foodCount"])
    food_abundance = float(orchard["abundance"])
    orchard_smell = float(orchard["smell"])
    smell_target = orchard.get("target")
    if food_target.get("race") and food_target.get("preferred") and smell_target:
        pref = food_target["preferred"]
        smell_target = {
            "x": int(round(0.55 * pref["x"] + 0.45 * smell_target["x"])),
            "y": int(round(0.55 * pref["y"] + 0.45 * smell_target["y"])),
        }
    elif food_target.get("preferred") and not smell_target:
        smell_target = food_target["preferred"]
    food_gate = 1.0
    if panic:
        food_gate *= float(d["panic_food_gate"])
    elif food_target.get("race"):
        food_gate *= float(d["race_food_gate"])
    elif undersized:
        food_gate *= float(d["undersized_food_gate"])
    if behind:
        food_gate = max(food_gate, float(d.get("catchup_food_gate", 1.55)))
    if early:
        food_gate *= float(d.get("early_food_gate_scale", 1.0))
    if starve_urgency > 0.35 or (
        food_dist_now is not None and food_dist_now <= 2 and danger_now > 1.5
    ):
        food_gate = max(food_gate, 0.7 + 0.45 * starve_urgency)
    if not panic and not food_target.get("race") and food_target["exclusivity"] > 0.65:
        food_gate = max(food_gate, 1.25)
    if (
        not food_target.get("race")
        and food_dist_now is not None
        and food_dist_now <= 2
        and food_target.get("rivalsCloser", 1) < 1
        and danger_now > 1
    ):
        food_gate = max(food_gate, float(d["exclusive_near_boost"]))
    if not panic and orchard_smell > 0.35:
        food_gate = max(food_gate, 1.0 + 0.7 * orchard_smell)
    if starve_urgency > 0.45:
        food_gate = max(food_gate, 1.15 + 0.5 * orchard_smell)
    smell_boost = 1.0 if panic else 1.0 + 0.85 * orchard_smell
    cone_boost = 1.7 if panic else (1.25 if undersized else 1.0)
    space_boost = 1.35 if panic else (1.15 if undersized else 1.0)

    preferred = food_target["preferred"]
    food_in_cone = False
    if preferred:
        face = cone["facing"]
        fwd = DELTA[face]
        right = (fwd[1], -fwd[0])
        dx = preferred["x"] - head["x"]
        dy = preferred["y"] - head["y"]
        ahead = dx * fwd[0] + dy * fwd[1]
        lat = abs(dx * right[0] + dy * right[1])
        food_in_cone = ahead > 0 and lat <= ahead

    scored: List[Dict[str, Any]] = []
    for move in MOVES:
        nxt = _add(head, DELTA[move])
        row: Dict[str, Any] = {"move": move, "fatal": False, "score": -1e9, "space": 0, "coneEmpty": 0}
        if neck and move == OPPOSITE[neck]:
            row["fatal"] = True
            row["reason"] = "neck"
            scored.append(row)
            continue
        if not _in_bounds(board, nxt):
            row["fatal"] = True
            row["reason"] = "wall"
            scored.append(row)
            continue
        if _key(nxt) in blocked:
            row["fatal"] = True
            row["reason"] = "body"
            scored.append(row)
            continue

        foods = board.get("food") or []
        on_food = any(_key(nxt) == _key(f) for f in foods)
        # Accurate 1-ply occupancy: head stays (neck), tip frees only if not eating.
        blocked_next = _blocked_after_move(board, you, nxt, grow=on_food)
        space = _flood(board, nxt, blocked_next)
        cone_next = _forward_cone_empty(board, nxt, move, blocked_next)
        ent_next = _region_entropy(board, nxt, move, blocked_next)
        you_next = {"id": you.get("id"), "length": you.get("length"), "body": you.get("body"), "head": nxt}
        sec = _sample_sectors(_build_retina(board, you_next, move))
        if preferred:
            food_dist = _manhattan(nxt, preferred)
        else:
            food_dist = _nearest_food(nxt, board.get("food") or [])
        food_pull = 0.0 if food_dist is None else 1.0 / (1.0 + food_dist)
        vel_threat = _velocity_threat(nxt, board, you, d)
        if food_target.get("race"):
            vel_threat *= float(d.get("race_threat_soften", 0.85))
        vel = -vel_threat
        cell_danger = _min_danger(nxt, board, you)
        snake_danger = _min_snake_danger(nxt, board, you)
        self_near = _min_self_body_dist(nxt, you, skip_tip=not on_food)
        # Fruit veto uses SNAKE danger only — walls must not make food look like a wall
        fruit_hard = snake_danger <= float(d["fruit_hard_danger"])
        fruit_soft = (not fruit_hard) and (
            snake_danger <= float(d["fruit_soft_danger"]) or sec["threat"] > 0.5
        )
        fruit_scale = 0.0 if fruit_hard else (float(d["fruit_soft_scale"]) if fruit_soft else 1.0)
        # Commit the bite: stepping onto food is smell→eat, not a visual hard veto
        if on_food and bool(d.get("food_cell_commits_bite", True)):
            # Still refuse if an equal/longer head is adjacent (real H2H on the berry)
            head_adj_eq = False
            my_len = you.get("length") or len(you.get("body") or [])
            for snake in board.get("snakes") or []:
                if snake.get("id") == you.get("id"):
                    continue
                sh = snake.get("head") or (snake.get("body") or [None])[0]
                if not sh:
                    continue
                their = snake.get("length") or len(snake.get("body") or [])
                if _manhattan(nxt, sh) == 1 and their >= my_len:
                    head_adj_eq = True
                    break
            if not head_adj_eq:
                fruit_hard = False
                fruit_soft = False
                fruit_scale = 1.0
        food_w = (
            0.7
            + 1.1 * hunger
            + 0.2 * courtship
            + 0.35 * size["size_advantage"]
            + 0.6 * starve_urgency
            + 0.55 * orchard_smell
            + (0.7 if food_target.get("race") else 0.4 * food_target["exclusivity"])
        )
        food_score = (
            fruit_scale
            * smell_boost
            * food_pull
            * food_w
            * (0.75 + 0.25 * safety)
            * food_gate
            * (1.15 if food_in_cone else 1.0)
            * (1.2 if food_target.get("race") else (0.75 + 0.45 * food_target["exclusivity"]))
        )
        if on_food and not fruit_hard:
            food_score *= float(d.get("bite_commit_boost", 1.6))
        my_len_i = int(you.get("length") or len(you.get("body") or []) or 1)
        next_len = my_len_i + (1 if on_food else 0)
        space_score = space / float(board["width"] * board["height"])
        # Late-game: refuse / heavily penalize pockets that can't fit our body
        fit_margin = int(d.get("pocket_fit_margin", 2) or 0)
        follow_space = _followup_max_space(board, you, nxt, on_food)
        follow_margin = int(d.get("followup_fit_margin", max(1, fit_margin // 2)) or 1)
        escape_ok = follow_space >= (next_len + follow_margin)
        pocket_ok = space >= (next_len + fit_margin) and escape_ok
        # Biting into a pocket that can't fit the grown body — veto unless starving.
        food_pocket_veto = bool(
            on_food
            and bool(d.get("food_requires_pocket_fit", True))
            and not pocket_ok
            and starve_urgency < float(d.get("food_pocket_starve_override", 0.7))
        )
        if food_pocket_veto:
            food_score *= 0.02
        space_len_w = 1.0 + float(d.get("long_body_space_weight", 0.0)) * min(
            1.0, max(0.0, (next_len - 8) / 20.0)
        )
        if not pocket_ok:
            space_score *= float(d.get("tight_pocket_penalty", 0.15))
        # Hug own coil less as we lengthen (self-collision precursor).
        self_hug_w = float(d.get("self_hug_penalty", 1.8)) * min(1.0, max(0.0, (next_len - 10) / 12.0))
        self_hug = 0.0
        if math.isfinite(self_near) and self_near <= 1:
            self_hug = self_hug_w * (1.2 if self_near <= 0 else 1.0)
        elif math.isfinite(self_near) and self_near <= 2:
            self_hug = 0.35 * self_hug_w
        # When behind/panicking, raw flood + 2-ply escape dominate fruit/cone lure.
        escape_focus = panic or behind
        flood_term = 0.0
        if escape_focus:
            flood_term = float(d.get("escape_flood_weight", 0.08)) * float(space) + float(
                d.get("escape_follow_weight", 0.1)
            ) * float(follow_space)
        if not escape_ok:
            flood_term -= float(d.get("dead_end_penalty", 12.0))
        # Edge hug along the wall is how panic traps closed (game e11da928).
        wall_dist = min(
            nxt["x"],
            nxt["y"],
            board["width"] - 1 - nxt["x"],
            board["height"] - 1 - nxt["y"],
        )
        wall_term = 0.0
        if escape_focus:
            wall_term = float(d.get("escape_wall_weight", 2.2)) * float(wall_dist)
            if wall_dist <= 0:
                wall_term -= float(d.get("edge_trap_penalty", 6.0))
            elif wall_dist <= 1:
                wall_term -= float(d.get("near_edge_penalty", 2.0))
        cone_score = float(cone_next["ratio"])
        danger_score = cell_danger / max_dim
        vel *= 1.0 - 0.45 * aggression
        lead_bonus = 0.6 * size["size_lead"] * food_pull if (dominant and not panic) else 0.0
        excl_term = 2.5 if food_target.get("race") else 1.5 * food_target["exclusivity"]
        threat_w = (0.75 if (dominant and food_target.get("race")) else 1.0) * 3.2
        fruit_term = fruit_scale * smell_boost * 2.2 * sec["fruit"] * food_gate
        retina_prefer = (
            2.0 * sec["open"]
            + fruit_term
            - threat_w * sec["threat"]
            + 1.6 * sec["entropy"]
        )
        exclusive_snack = (
            not food_target.get("race")
            and food_dist_now is not None
            and food_dist_now <= 2
            and food_target.get("rivalsCloser", 1) < 1
            and food_target["exclusivity"] > 0.6
        )
        bite_override = bool(d.get("bite_override_panic", True)) and (exclusive_snack or on_food)
        if panic and not bite_override:
            panic_open = 3.5 * sec["open"] + 0.05 * float(cone_next["empty"])
        elif panic:
            panic_open = 1.2 * sec["open"]
        else:
            panic_open = 0.0
        scent_fn = orchard.get("scent_at")
        scent_next = float(scent_fn(nxt)) if callable(scent_fn) else 0.0
        scent_delta = scent_next - float(orchard.get("scentHere") or 0.0)
        if smell_target is not None:
            dist_head = _manhattan(head, smell_target)
            dist_next = _manhattan(nxt, smell_target)
            toward_pocket = 1.0 / (1.0 + dist_next) - 1.0 / (1.0 + dist_head)
        else:
            toward_pocket = 0.0
        # Smell is not blocked by wall-as-fruit-hard — only dampened by real snake danger
        smell_scale = 1.0 if (on_food and not fruit_hard) else max(fruit_scale, float(d.get("smell_min_scale", 0.55)))
        if fruit_hard and not on_food:
            smell_scale = float(d.get("smell_min_scale", 0.55))
        scent_prefer = (
            (float(d["smell_panic_dampen"]) if panic else 1.0)
            * smell_boost
            * smell_scale
            * (
                2.8 * max(0.0, scent_delta)
                + 2.2 * max(0.0, toward_pocket)
                + 0.55 * scent_next
            )
        )
        # Behind/panic: damp fruit chase so escape flood can win.
        food_escape_scale = float(d.get("escape_food_scale", 0.35)) if escape_focus else 1.0
        row.update(
            space=space,
            followSpace=follow_space,
            escapeOk=escape_ok,
            wallDist=wall_dist,
            coneEmpty=cone_next["empty"],
            foodExclusivity=food_target["exclusivity"],
            entropy=ent_next["entropy"],
            retinaOpen=sec["open"],
            retinaFruit=sec["fruit"],
            retinaThreat=sec["threat"],
            sectorEntropy=sec["entropy"],
            fruitHard=fruit_hard,
            fruitSoft=fruit_soft,
            fruitScale=fruit_scale,
            onFood=on_food,
            snakeDanger=snake_danger,
            pocketOk=pocket_ok,
            foodPocketVeto=food_pocket_veto,
            selfNear=self_near if math.isfinite(self_near) else None,
            scentNext=scent_next,
            scentDelta=scent_delta,
            towardPocket=toward_pocket,
            score=(
                (5.0 - 1.5 * aggression) * danger_score
                + 1.6 * space_score * space_boost * space_len_w
                + 2.4 * cone_score * cone_boost
                + 2.8 * ent_next["entropy"]
                + retina_prefer
                + scent_prefer
                + panic_open
                + 1.3 * vel
                + (7.5 + 3.0 * hunger + 2.5 * starve_urgency + excl_term)
                * food_score
                * food_escape_scale
                + 0.45 * courtship * space_score
                + lead_bonus
                + flood_term
                + wall_term
                - self_hug
            ),
        )
        scored.append(row)

    legal = [s for s in scored if not s["fatal"]]
    # Prefer pockets that fit our body when any fitting escape exists (self-trap fix).
    fitting = [s for s in legal if s.get("pocketOk", True)]
    if fitting:
        legal = fitting
    # Prefer not biting into unfittable pockets when any other legal move exists.
    non_food_trap = [s for s in legal if not s.get("foodPocketVeto")]
    if non_food_trap:
        legal = non_food_trap
    # Behind/panic or already squeezed: maximize 2-ply escape, space, then stay off edges.
    if (panic or behind) or not fitting:
        legal.sort(
            key=lambda s: (
                s.get("followSpace") or 0,
                s.get("space") or 0,
                s.get("wallDist") or 0,
                s["score"],
            ),
            reverse=True,
        )
    else:
        legal.sort(
            key=lambda s: (s["score"], s.get("followSpace") or 0, s.get("space") or 0),
            reverse=True,
        )
    pick = legal[0]["move"] if legal else OPPOSITE.get(neck or "up", "up")
    pick_sec = legal[0] if legal else None
    eyes_open = pick_sec["retinaOpen"] if pick_sec and "retinaOpen" in pick_sec else here_sectors["open"]
    eyes_fruit = pick_sec["retinaFruit"] if pick_sec and "retinaFruit" in pick_sec else here_sectors["fruit"]
    eyes_threat = (
        pick_sec["retinaThreat"] if pick_sec and "retinaThreat" in pick_sec else here_sectors["threat"]
    )
    eyes_entropy = (
        pick_sec["sectorEntropy"] if pick_sec and "sectorEntropy" in pick_sec else here_sectors["entropy"]
    )
    threat_vetoes_fruit = eyes_threat > 0.42 and eyes_fruit > 0.04 and eyes_threat > eyes_open
    open_wins = eyes_open > 0.45 and eyes_open > eyes_fruit + 0.15 and eyes_threat < 0.28
    if starve_urgency > 0.5:
        shout = "starving — hunt"
    elif panic:
        shout = "escape cone!"
    elif orchard_smell > 0.55 and not food_target.get("race"):
        shout = "orchard smell — feast"
    elif threat_vetoes_fruit:
        shout = "eyes say danger"
    elif open_wins and not food_target.get("race"):
        shout = "eyes say space"
    elif food_target.get("race"):
        shout = "racing fruit — bigger"
    elif food_target["exclusivity"] > 0.7 and not food_target["contested"]:
        shout = "courting free fruit"
    elif food_target["contested"] and food_target["exclusivity"] < 0.45:
        shout = "skipping contested fruit"
    elif here_entropy["entropy"] > 0.55:
        shout = "seeking open entropy"
    elif food_in_cone and food_dist_now is not None and food_dist_now <= 2:
        shout = "fruit in view"
    elif courtship > 0.65:
        shout = "courting the open board"
    elif size["longest"] and size["size_lead"] > 0.15:
        shout = "outgrowing the board"
    elif courtship < 0.25:
        shout = "danger!"
    else:
        shout = ""

    neuron_targets = {
        "courtship_pC1": courtship * (0.25 if panic else 1.0),
        "courtship_vPR6": courtship
        * food_target["exclusivity"]
        * (1.0 - hunger)
        * (0.15 if panic else 1.0),
        "ALPN": 0.35 + 0.55 * (1.0 - safety) + 0.35 * here_sectors["threat"] + (0.2 if panic else 0.0),
        "DAN": (
            0.15
            + 0.3 * hunger * max(safety, 0.35)
            + 0.2 * courtship
            + 0.25 * size["size_advantage"]
            + 0.45 * starve_urgency
            + 0.55 * orchard_smell
            + (0.45 if food_target.get("race") else 0.25 * food_target["exclusivity"])
            + (0.15 if food_in_cone else 0.0)
            + 0.35 * here_sectors["fruit"]
            + (0.2 if (food_dist_now is not None and food_dist_now <= 2) else 0.0)
        ),
        "MBON": 0.15
        + 0.25 * safety
        + 0.4 * here_sectors["open"]
        + 0.35 * here_entropy["entropy"]
        + (0.1 if panic else 0.0),
        "DAN_risk": (
            max(size["size_advantage"], 0.7)
            if food_target.get("race")
            else size["size_advantage"] * (0.3 if panic else 1.0) * (1.0 + 0.3 * orchard_smell)
        ),
        "aSPIC": size["size_lead"],
        "KC_escape": 0.85 if panic else max(0.0, 1.0 - safety) * 0.35 + 0.4 * here_sectors["threat"],
    }

    return {
        "move": pick,
        "shout": shout,
        "scored": scored,
        "signals": {
            "courtship": courtship,
            "safety": safety,
            "hunger": hunger,
            "danger_distance": danger_now,
            "food_distance": food_dist_now,
            "space_best": legal[0]["space"] if legal else 0,
            "cone_empty": cone["empty"],
            "cone_capacity": cone["capacity"],
            "cone_ratio": cone["ratio"],
            "facing": cone["facing"],
            "length_you": size["length_you"],
            "length_max_rival": size["length_max_rival"],
            "size_advantage": size["size_advantage"],
            "size_lead": size["size_lead"],
            "longest": size["longest"],
            "panic": panic,
            "behind": behind,
            "len_gap": len_gap,
            "snake_near": snake_near,
            "food_gate": food_gate,
            "health": health,
            "starve_urgency": starve_urgency,
            "food_in_cone": food_in_cone,
            "food_count": food_count,
            "food_abundance": food_abundance,
            "orchard_smell": orchard_smell,
            "smell_boost": smell_boost,
            "smell_target": smell_target,
            "scent_here": orchard.get("scentHere"),
            "cluster_mass": orchard.get("clusterMass"),
            "food_exclusivity": food_target["exclusivity"],
            "food_contested": food_target["contested"],
            "food_rivals_closer": food_target["rivalsCloser"],
            "food_rivals_heading": food_target["rivalsHeading"],
            "preferred_food": preferred,
            "food_mode": food_target.get("mode"),
            "food_race": bool(food_target.get("race")),
            "region_entropy": here_entropy["entropy"],
            "mobility_entropy": here_entropy["mobility"],
            "fruit_entropy": here_entropy["fruit"],
            "retina_open": here_sectors["open"],
            "retina_fruit": here_sectors["fruit"],
            "retina_threat": here_sectors["threat"],
            "sector_entropy": eyes_entropy,
            "wiring": d.get("wiring") or "retina_sectors_v1_orchard",
            "dials_id": d.get("id"),
            "neuron_targets": neuron_targets,
        },
    }


def _frames_pending() -> int:
    with _lock:
        return len(_frames)


def _find_battlesnake() -> Optional[str]:
    found = shutil.which("battlesnake") or shutil.which("battlesnake.exe")
    if found:
        return found
    # Common Go install location when PATH isn't refreshed
    try:
        gopath = subprocess.check_output(["go", "env", "GOPATH"], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        gopath = os.path.expanduser("~/go")
    candidate = os.path.join(gopath, "bin", "battlesnake")
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


def _start_play(body: Dict[str, Any]) -> Dict[str, Any]:
    global _play_proc
    cli = _find_battlesnake()
    if not cli:
        return {
            "ok": False,
            "error": "battlesnake CLI not found — install with: go install github.com/BattlesnakeOfficial/rules/cli/battlesnake@latest",
        }

    width = int(body.get("width") or 11)
    height = int(body.get("height") or 11)
    gametype = str(body.get("gametype") or "solo")
    delay = int(body.get("delay") or 120)
    seed = body.get("seed")
    url = f"http://127.0.0.1:{PORT}"
    name = str(body.get("name") or SNAKE_NAME)

    if _play_proc and _play_proc.poll() is None:
        return {"ok": False, "error": "a local game is already running", "pid": _play_proc.pid}

    # Multiplayer: opponents = [{name, url}, ...] or legacy opponent_url
    opponents: List[Dict[str, str]] = []
    raw_opps = body.get("opponents")
    if isinstance(raw_opps, list):
        for o in raw_opps:
            if isinstance(o, dict) and o.get("url"):
                opponents.append(
                    {
                        "name": str(o.get("name") or "Opponent"),
                        "url": str(o["url"]),
                    }
                )
    elif body.get("opponent_url"):
        opponents.append(
            {
                "name": str(body.get("opponent_name") or "Opponent"),
                "url": str(body["opponent_url"]),
            }
        )

    if opponents and gametype == "solo":
        gametype = "standard"

    cmd = [
        cli,
        "play",
        "-W",
        str(width),
        "-H",
        str(height),
        "--name",
        name,
        "--url",
        url,
        "-g",
        gametype,
        "-d",
        str(delay),
        "-v",
    ]
    if seed is not None and str(seed).strip() != "":
        cmd.extend(["--seed", str(int(seed))])
    for o in opponents:
        cmd.extend(["--name", o["name"], "--url", o["url"]])

    play_meta = {
        "cmd": cmd,
        "started_at": time.time(),
        "opponents": opponents,
        "seed": int(seed) if seed is not None and str(seed).strip() != "" else None,
    }
    _set_last(phase="playing", play=play_meta)
    _play_proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    def _watch() -> None:
        assert _play_proc is not None
        out, _ = _play_proc.communicate()
        _set_last(
            phase="end",
            play={
                "cmd": cmd,
                "exit_code": _play_proc.returncode,
                "finished_at": time.time(),
                "log_tail": (out or "")[-4000:],
                "opponents": opponents,
                "seed": play_meta.get("seed"),
            },
        )

    threading.Thread(target=_watch, daemon=True).start()
    return {
        "ok": True,
        "pid": _play_proc.pid,
        "cmd": cmd,
        "url": url,
        "name": name,
        "opponents": opponents,
        "gametype": gametype,
        "seed": play_meta.get("seed"),
    }


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", ""):
            d = dials_mod.load_dials()
            self._json(
                200,
                {
                    "apiversion": "1",
                    "author": AUTHOR,
                    "color": COLOR,
                    "head": HEAD,
                    "tail": TAIL,
                    "version": str(d.get("id") or "lofly-unknown"),
                },
            )
            return
        if path == "/dev/status":
            cli = _find_battlesnake()
            running = _play_proc is not None and _play_proc.poll() is None
            d = dials_mod.load_dials()
            self._json(
                200,
                {
                    "ok": True,
                    "port": PORT,
                    "name": SNAKE_NAME,
                    "battlesnake_cli": cli,
                    "play_running": running,
                    "play_pid": _play_proc.pid if running and _play_proc else None,
                    "last": _get_last(),
                    "frames_pending": _frames_pending(),
                    "games_logged": len(game_log.list_games(50)),
                    "log_dir": str(game_log.LOG_DIR),
                    "dials_id": d.get("id"),
                    "dials_path": str(dials_mod.dials_path() or "(defaults)"),
                    "wiring": d.get("wiring"),
                },
            )
            return
        if path == "/dev/last":
            self._json(200, _get_last())
            return
        if path == "/dev/frames":
            qs = parse_qs(urlparse(self.path).query)
            n = int((qs.get("n") or ["12"])[0] or 12)
            self._json(200, _take_frames(n))
            return
        if path == "/dev/games":
            qs = parse_qs(urlparse(self.path).query)
            limit = int((qs.get("limit") or ["30"])[0] or 30)
            dials_filter = (qs.get("dials_id") or [""])[0].strip() or None
            games = game_log.list_games(min(200, max(1, limit)))
            if dials_filter:
                games = [g for g in games if (g.get("dials_id") or "") == dials_filter]
            self._json(200, {"games": games, "dials_id": dials_filter})
            return
        if path == "/dev/batch":
            qs = parse_qs(urlparse(self.path).query)
            limit = int((qs.get("limit") or ["20"])[0] or 20)
            self._json(200, game_log.batch_evaluate(min(200, max(1, limit))))
            return
        if path.startswith("/dev/game/"):
            gid = path[len("/dev/game/") :] or "latest"
            # optional ?summary=1
            qs = parse_qs(urlparse(self.path).query)
            game = game_log.load_game(gid)
            if not game:
                self._json(404, {"error": "game not found", "game_id": gid})
                return
            if (qs.get("summary") or [""])[0] in ("1", "true", "yes"):
                self._json(
                    200,
                    {
                        "game_id": game.get("game_id"),
                        "dials_id": game.get("dials_id"),
                        "wiring": game.get("wiring"),
                        "outcome": game.get("outcome"),
                        "final": game.get("final"),
                        "analysis": game.get("analysis") or game_log.analyze_game(game),
                        "n_turns": len(game.get("turns") or []),
                    },
                )
                return
            self._json(200, game)
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        data = self._read_json()

        if path == "/start":
            gid = (data.get("game") or {}).get("id")
            print("GAME START", gid)
            game_log.on_start(data)
            _clear_frames()
            frame = {
                "phase": "start",
                "game_id": gid,
                "turn": 0,
                "request": data,
                "decision": None,
            }
            _set_last(**frame)
            _push_frame(frame)
            self._json(200, {})
            return

        if path == "/end":
            gid = (data.get("game") or {}).get("id")
            print("GAME END", gid)
            finished = game_log.on_end(data)
            analysis = (finished or {}).get("analysis") or {}
            print(
                f"  logged → outcome={analysis.get('outcome')} "
                f"turns={analysis.get('n_turns')} "
                f"food≈{analysis.get('food_eaten_est')} "
                f"near_miss={analysis.get('near_miss_turns')}"
            )
            frame = {
                "phase": "end",
                "game_id": gid,
                "turn": data.get("turn"),
                "request": data,
                "decision": None,
                "analysis": analysis,
                "logged_game_id": (finished or {}).get("game_id"),
            }
            _set_last(**frame)
            _push_frame(frame)
            self._json(200, {})
            return

        if path == "/move":
            decision = decide(data)
            turn = data.get("turn")
            print(
                f"MOVE turn={turn} → {decision['move']} "
                f"court={decision['signals']['courtship']:.2f}"
            )
            packed = {
                "move": decision["move"],
                "shout": decision.get("shout") or "",
                "signals": decision["signals"],
                "scored": decision["scored"],
            }
            game_log.on_move(data, packed)
            frame = {
                "phase": "move",
                "game_id": (data.get("game") or {}).get("id"),
                "turn": turn,
                "request": data,
                "decision": packed,
            }
            _set_last(**frame)
            _push_frame(frame)
            self._json(
                200,
                {"move": decision["move"], "shout": decision.get("shout") or ""},
            )
            return

        if path == "/dev/play":
            result = _start_play(data or {})
            self._json(200 if result.get("ok") else 400, result)
            return

        self._json(404, {"error": "not found"})

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep noise down for polling
        msg = fmt % args
        if "/dev/last" in msg or "/dev/status" in msg or "/dev/frames" in msg:
            return
        print("%s - %s" % (self.address_string(), msg))


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    cli = _find_battlesnake()
    d = dials_mod.load_dials()
    print(f"FS-Avatar Battlesnake on http://0.0.0.0:{PORT}")
    print(f"  identity: {SNAKE_NAME} (author={AUTHOR}, color={COLOR})")
    print(f"  dials: {d.get('id')} ← {dials_mod.dials_path() or '(defaults)'}")
    print(f"  battlesnake CLI: {cli or 'NOT FOUND — install to use /dev/play'}")
    print("  console helpers: GET /dev/status  GET /dev/last  GET /dev/frames  GET /dev/games  GET /dev/game/latest?summary=1  GET /dev/batch  POST /dev/play")
    print(f"  game logs: {game_log.LOG_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()
