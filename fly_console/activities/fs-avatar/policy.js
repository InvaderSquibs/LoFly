/**
 * FS-Avatar move policy — Battlesnake-compatible.
 *
 * Priority (matches Funathon strategy + fly hypothesis):
 *   1. Avoid danger (walls, bodies, hazards, losing head-to-heads)
 *   2. Prefer open space (flood fill)
 *   3. Steer away from opponent head velocity
 *   4. Seek food when safe / hungry
 * Courtship rises with distance from danger — later wired to courtship neurons.
 */
(function (global) {
  "use strict";

  const MOVES = ["up", "down", "left", "right"];
  const DELTA = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };

  const DEFAULT_DIALS = {
    id: "defaults",
    wiring: "retina_sectors_v1_orchard",
    panic_food_gate: 0.8,
    panic_safety_thresh: 0.18,
    panic_danger_thresh: 1.0,
    panic_tunnel_thresh: 0.08,
    starve_blocks_panic_above: 0.55,
    fruit_hard_danger: 1.0,
    fruit_soft_danger: 2.0,
    fruit_soft_scale: 0.4,
    wall_counts_as_danger: true,
    undersized_food_gate: 1.4,
    catchup_len_gap: 2,
    catchup_food_gate: 1.55,
    race_food_gate: 1.35,
    exclusive_near_boost: 1.15,
    smell_panic_dampen: 0.75,
    bite_override_panic: true,
    early_game_turns: 18,
    early_aggression_cap: 0.4,
    early_food_gate_scale: 1.0,
    equal_or_longer_head_threat: 6.5,
    shorter_head_threat: 0.35,
    race_threat_soften: 1.0,
    food_cell_commits_bite: true,
    bite_commit_boost: 1.75,
    smell_min_scale: 0.6,
    pocket_fit_margin: 5,
    long_body_space_weight: 2.2,
    tight_pocket_penalty: 0.03,
    food_requires_pocket_fit: true,
    food_pocket_starve_override: 0.7,
    self_hug_penalty: 2.0,
  };

  function getDials() {
    const override = global.FsAvatarDials;
    if (override && typeof override === "object") {
      return Object.assign({}, DEFAULT_DIALS, override);
    }
    return DEFAULT_DIALS;
  }

  function key(p) {
    return p.x + "," + p.y;
  }

  function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
  }

  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function lastMove(snake) {
    if (!snake || !snake.body || snake.body.length < 2) return null;
    const h = snake.body[0];
    const n = snake.body[1];
    const dx = h.x - n.x;
    const dy = h.y - n.y;
    if (dx === 1) return "right";
    if (dx === -1) return "left";
    if (dy === 1) return "up";
    if (dy === -1) return "down";
    return null;
  }

  function occupiedSet(board, you, opts) {
    opts = opts || {};
    const set = new Set();
    const snakes = board.snakes || [];
    for (let s = 0; s < snakes.length; s++) {
      const snake = snakes[s];
      const body = snake.body || [];
      // Tail vacates unless that snake just ate (length grows next turn).
      // Conservative: treat full body as blocked; optional skip tip for you.
      const end = opts.ignoreYouTail && snake.id === you.id && body.length > 1
        ? body.length - 1
        : body.length;
      for (let i = 0; i < end; i++) set.add(key(body[i]));
    }
    (board.hazards || []).forEach((h) => set.add(key(h)));
    return set;
  }

  /** Occupancy after stepping to next. Head stays (neck); tip frees only if not growing. */
  function blockedAfterMove(board, you, next, grow) {
    const set = new Set();
    const snakes = board.snakes || [];
    for (let s = 0; s < snakes.length; s++) {
      const snake = snakes[s];
      const body = snake.body || [];
      if (!body.length) continue;
      if (snake.id === you.id) {
        const last = grow || body.length <= 1 ? body.length : body.length - 1;
        for (let i = 0; i < last; i++) set.add(key(body[i]));
      } else {
        for (let i = 0; i < body.length; i++) set.add(key(body[i]));
      }
    }
    (board.hazards || []).forEach((h) => set.add(key(h)));
    set.delete(key(next));
    return set;
  }

  function minSelfBodyDist(cell, you, skipTip) {
    const body = you.body || [];
    if (body.length < 2) return Infinity;
    const end = skipTip && body.length > 1 ? body.length - 1 : body.length;
    let best = Infinity;
    for (let i = 1; i < end; i++) {
      const d = manhattan(cell, body[i]);
      if (d < best) best = d;
    }
    return best;
  }

  function inBounds(board, p) {
    return p.x >= 0 && p.y >= 0 && p.x < board.width && p.y < board.height;
  }

  function floodFill(board, start, blocked) {
    if (!inBounds(board, start) || blocked.has(key(start))) return 0;
    const seen = new Set([key(start)]);
    const q = [start];
    let n = 0;
    while (q.length) {
      const cur = q.shift();
      n++;
      for (let i = 0; i < MOVES.length; i++) {
        const nxt = add(cur, DELTA[MOVES[i]]);
        const k = key(nxt);
        if (seen.has(k) || !inBounds(board, nxt) || blocked.has(k)) continue;
        seen.add(k);
        q.push(nxt);
      }
    }
    return n;
  }

  function nearestFoodDist(youHead, food) {
    if (!food || !food.length) return null;
    let best = Infinity;
    for (let i = 0; i < food.length; i++) {
      const d = manhattan(youHead, food[i]);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Score fruits by exclusivity: rivals closer or heading toward a fruit = contested.
   * Courtship prefers the open orchard — uncontested fruit over a crowded pile.
   */
  function foodCourtshipTargets(board, you, head) {
    const foods = board.food || [];
    if (!foods.length) {
      return {
        preferred: null,
        exclusivity: 1,
        contested: false,
        myDist: null,
        rivalsCloser: 0,
        rivalsHeading: 0,
        ranked: [],
      };
    }
    const foes = (board.snakes || []).filter((s) => s.id !== you.id);
    const ranked = [];
    for (let i = 0; i < foods.length; i++) {
      const food = foods[i];
      const myDist = manhattan(head, food);
      let rivalsCloser = 0;
      let rivalsHeading = 0;
      for (let f = 0; f < foes.length; f++) {
        const snake = foes[f];
        const fh = snake.head || (snake.body && snake.body[0]);
        if (!fh) continue;
        const theirDist = manhattan(fh, food);
        if (theirDist < myDist) rivalsCloser += 1;
        else if (theirDist === myDist) rivalsCloser += 0.5;
        const vel = lastMove(snake);
        if (vel) {
          const proj = add(fh, DELTA[vel]);
          if (manhattan(proj, food) < theirDist) rivalsHeading += 1;
        }
      }
      const contest = rivalsCloser + 0.8 * rivalsHeading;
      const exclusivity = 1 / (1 + contest);
      // Slightly farther exclusive fruit beats nearer contested fruit
      const value = exclusivity * (1 / (1 + myDist)) * (0.7 + 0.6 * exclusivity);
      ranked.push({
        food,
        myDist,
        contest,
        exclusivity,
        value,
        rivalsCloser,
        rivalsHeading,
      });
    }
    ranked.sort((a, b) => b.value - a.value);
    const best = ranked[0];
    return {
      preferred: best.food,
      exclusivity: best.exclusivity,
      contested: best.contest >= 1,
      myDist: best.myDist,
      rivalsCloser: best.rivalsCloser,
      rivalsHeading: best.rivalsHeading,
      ranked,
    };
  }

  /**
   * Spatial orchard scent: proximity-weighted food pockets + attractor location.
   * Closer fruit smells stronger; clusters (pockets) pull harder than lone berries.
   */
  function orchardScent(board, head) {
    const foods = board.food || [];
    const empty = {
      foodCount: 0,
      abundance: 0,
      smell: 0,
      scentHere: 0,
      target: null,
      clusterMass: 0,
      scentAt: function () {
        return 0;
      },
    };
    if (!foods.length || !head) return empty;

    const tau = 2.5;
    const scentAt = function (p) {
      let s = 0;
      for (let i = 0; i < foods.length; i++) {
        s += Math.exp(-manhattan(p, foods[i]) / tau);
      }
      return s;
    };

    // Pocket mass: each food + nearby fruits
    let bestFood = foods[0];
    let bestScore = -Infinity;
    let bestMass = 0;
    for (let i = 0; i < foods.length; i++) {
      const f = foods[i];
      let mass = 0;
      for (let j = 0; j < foods.length; j++) {
        mass += Math.exp(-manhattan(f, foods[j]) / 2.0);
      }
      const dist = manhattan(head, f);
      const score = mass / (1 + dist);
      if (score > bestScore) {
        bestScore = score;
        bestFood = f;
        bestMass = mass;
      }
    }

    // Attractor = scent-weighted centroid of the pocket around bestFood
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (let i = 0; i < foods.length; i++) {
      const f = foods[i];
      const d = manhattan(bestFood, f);
      if (d > 4) continue;
      const w = Math.exp(-d / 2.0);
      wx += w * f.x;
      wy += w * f.y;
      wsum += w;
    }
    const target =
      wsum > 0
        ? { x: Math.round(wx / wsum), y: Math.round(wy / wsum) }
        : { x: bestFood.x, y: bestFood.y };

    const scentHere = scentAt(head);
    const abundance = Math.max(0, Math.min(1, 1 - Math.exp(-foods.length / 2.2)));
    const smell = Math.max(
      0,
      Math.min(1, 0.4 * abundance + 0.6 * Math.min(1, scentHere / Math.max(1.2, foods.length * 0.45)))
    );

    return {
      foodCount: foods.length,
      abundance,
      smell,
      scentHere,
      target,
      clusterMass: bestMass,
      scentAt,
    };
  }

  /**
   * Race only with a real length lead + uncontested fruit.
   * Equal-length / race_force removed — those were eating early H2Hs.
   */
  function foodRaceOrYield(board, you, head, size) {
    const base = foodCourtshipTargets(board, you, head);
    const ranked = base.ranked || [];
    if (!ranked.length) {
      return Object.assign({}, base, { mode: "none", race: false });
    }
    // Strict: must be longer than the biggest rival (advantage ≥ 0.55 follows from lead ≥ 1 on small boards)
    const canRace =
      size.length_you > size.length_max_rival &&
      (size.size_advantage >= 0.55 || size.size_lead > 0);
    if (canRace) {
      const raceable = ranked
        .filter((r) => r.rivalsCloser < 1)
        .slice()
        .sort((a, b) => a.myDist - b.myDist || b.exclusivity - a.exclusivity);
      if (raceable.length) {
        const pick = raceable[0];
        return {
          preferred: pick.food,
          exclusivity: pick.exclusivity,
          contested: pick.contest >= 1,
          myDist: pick.myDist,
          rivalsCloser: pick.rivalsCloser,
          rivalsHeading: pick.rivalsHeading,
          ranked,
          mode: "race",
          race: true,
        };
      }
      // Bigger but every fruit is contested — yield, don't force a suicide race
      return Object.assign({}, base, { mode: "yield_contested", race: false });
    }
    return Object.assign({}, base, { mode: "yield", race: false });
  }

  /**
   * Region entropy proxy: mobility (log flood-fill) + cone openness + fruit in cone.
   * Higher = more degrees of freedom and food options ahead.
   */
  function regionEntropy(board, head, facing, blocked) {
    const face = facing && DELTA[facing] ? facing : "up";
    const cone = forwardConeEmpty(board, head, face, blocked);
    const space = floodFill(board, head, blocked);
    const boardArea = Math.max(1, board.width * board.height);
    const mobility = Math.log(1 + space) / Math.log(1 + boardArea);
    const foods = board.food || [];
    let foodInCone = 0;
    if (foods.length && cone.capacity) {
      const fwd = DELTA[face];
      const right = { x: fwd.y, y: -fwd.x };
      const depth = cone.depth || Math.max(3, Math.min(board.width, board.height) - 1);
      const foodSet = new Set(foods.map((p) => key(p)));
      for (let d = 1; d <= depth; d++) {
        for (let lat = -d; lat <= d; lat++) {
          const p = {
            x: head.x + d * fwd.x + lat * right.x,
            y: head.y + d * fwd.y + lat * right.y,
          };
          if (foodSet.has(key(p))) foodInCone++;
        }
      }
    }
    const fruit = foods.length ? foodInCone / foods.length : 0;
    const open = cone.ratio;
    // Weighted mix — mobility dominates, fruit availability matters for courtship/hunt
    const entropy = Math.max(0, Math.min(1, 0.5 * mobility + 0.3 * open + 0.2 * fruit));
    return {
      entropy,
      mobility,
      open,
      fruit,
      foodInCone,
      space,
      facing: face,
    };
  }

  function facingAxes(facing) {
    const face = facing && DELTA[facing] ? facing : "up";
    const fwd = DELTA[face];
    return { face, fwd, right: { x: fwd.y, y: -fwd.x } };
  }

  /**
   * Egocentric 4-channel retina (forward-up, right-positive). Same frame as hex eyes.
   * Channels: open, fruit, threat, self + forward-cone mask.
   */
  function buildRetina(board, you, facing) {
    const head = you.head || (you.body && you.body[0]);
    const { face, fwd, right } = facingAxes(facing);
    const depth = Math.max(3, Math.min(board.width, board.height) - 1);
    const foodSet = new Set((board.food || []).map(key));
    const youSet = new Set((you.body || []).map(key));
    const myLen = you.length || (you.body && you.body.length) || 1;
    const threatMap = new Map();
    const snakes = board.snakes || [];
    for (let s = 0; s < snakes.length; s++) {
      const snake = snakes[s];
      if (snake.id === you.id) continue;
      const len = snake.length || (snake.body && snake.body.length) || 1;
      const hot = 0.6 + 0.4 * Math.min(1, len / Math.max(myLen, 1));
      const body = snake.body || [];
      for (let i = 0; i < body.length; i++) {
        const w = (i === 0 ? 1.6 : 0.7) * hot;
        const k = key(body[i]);
        threatMap.set(k, Math.max(threatMap.get(k) || 0, w));
      }
    }
    const cells = [];
    for (let d = 0; d <= depth; d++) {
      for (let lat = -d; lat <= d; lat++) {
        if (d === 0 && lat !== 0) continue;
        const p = {
          x: head.x + d * fwd.x + lat * right.x,
          y: head.y + d * fwd.y + lat * right.y,
        };
        const inb = inBounds(board, p);
        const k = key(p);
        const inCone = d >= 1 && Math.abs(lat) <= d;
        let open = 0;
        let fruit = 0;
        let threat = 0;
        let self = 0;
        if (!inb) {
          threat = 0.35;
        } else {
          if (youSet.has(k)) self = 1;
          if (foodSet.has(k)) fruit = 1;
          if (threatMap.has(k)) threat = threatMap.get(k);
          if (!self && threat < 0.5) open = fruit ? 0.8 : 1;
        }
        cells.push({ d, lat, p, inb, inCone, open, fruit, threat, self });
      }
    }
    return { facing: face, depth, cells, fwd, right };
  }

  function sampleSectors(retina) {
    const cells = (retina && retina.cells) || [];
    function bag(pred) {
      let n = 0;
      let open = 0;
      let fruit = 0;
      let threat = 0;
      let self = 0;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (!pred(c)) continue;
        n++;
        open += c.open;
        fruit += c.fruit;
        threat += c.threat;
        self += c.self;
      }
      const inv = n ? 1 / n : 0;
      const o = open * inv;
      const f = fruit * inv;
      const t = Math.min(1, threat * inv * 2);
      const entropy = Math.max(0, Math.min(1, 0.65 * o + 0.35 * Math.min(1, fruit / Math.max(1, n * 0.12))));
      return { n, open: o, fruit: f, threat: t, self: self * inv, entropy };
    }
    const forward = bag((c) => c.d >= 1 && Math.abs(c.lat) <= Math.max(1, Math.floor(c.d * 0.45)));
    const left = bag((c) => c.d >= 1 && c.lat < 0 && Math.abs(c.lat) <= c.d);
    const right = bag((c) => c.d >= 1 && c.lat > 0 && Math.abs(c.lat) <= c.d);
    const near = bag((c) => c.d >= 1 && c.d <= 2);
    const cone = bag((c) => c.inCone && c.d >= 1);
    const open = 0.55 * forward.open + 0.15 * left.open + 0.15 * right.open + 0.15 * near.open;
    const fruit = 0.6 * forward.fruit + 0.15 * left.fruit + 0.15 * right.fruit + 0.1 * near.fruit;
    const threat =
      0.35 * forward.threat + 0.15 * left.threat + 0.15 * right.threat + 0.35 * near.threat;
    const entropy = Math.max(
      0,
      Math.min(1, 0.5 * forward.entropy + 0.2 * cone.entropy + 0.3 * (0.65 * open + 0.35 * fruit))
    );
    return { forward, left, right, near, cone, open, fruit, threat, entropy };
  }

  function minSnakeDanger(youHead, board, you) {
    let best = Infinity;
    const snakes = board.snakes || [];
    for (let s = 0; s < snakes.length; s++) {
      const snake = snakes[s];
      if (snake.id === you.id) continue;
      const head = snake.head || (snake.body && snake.body[0]);
      if (!head) continue;
      best = Math.min(best, manhattan(youHead, head));
      const body = snake.body || [];
      for (let i = 0; i < body.length; i++) {
        best = Math.min(best, manhattan(youHead, body[i]));
      }
    }
    if (!isFinite(best)) best = Math.max(board.width, board.height);
    return best;
  }

  function minDangerDistance(youHead, board, you) {
    let best = minSnakeDanger(youHead, board, you);
    const d = getDials();
    if (d.wall_counts_as_danger !== false) {
      const wallDist = Math.min(
        youHead.x,
        youHead.y,
        board.width - 1 - youHead.x,
        board.height - 1 - youHead.y
      );
      best = Math.min(best, wallDist + 0.5);
    }
    if (!isFinite(best)) best = Math.max(board.width, board.height);
    return best;
  }

  /**
   * Empty cells in a forward-facing cone (same egocentric frame as hex eyes).
   * Depth grows ahead of facing; lateral half-width ≈ depth (≈45°).
   */
  function forwardConeEmpty(board, head, facing, blocked) {
    const face = facing && DELTA[facing] ? facing : "up";
    const fwd = DELTA[face];
    const right = { x: fwd.y, y: -fwd.x };
    const depth = Math.max(3, Math.min(board.width, board.height) - 1);
    let empty = 0;
    let capacity = 0;
    for (let d = 1; d <= depth; d++) {
      const half = d; // |lateral| <= d → widening cone
      for (let lat = -half; lat <= half; lat++) {
        capacity++;
        const p = {
          x: head.x + d * fwd.x + lat * right.x,
          y: head.y + d * fwd.y + lat * right.y,
        };
        if (!inBounds(board, p)) continue;
        if (blocked.has(key(p))) continue;
        empty++;
      }
    }
    return {
      empty,
      capacity,
      ratio: capacity ? empty / capacity : 0,
      facing: face,
      depth,
    };
  }

  /** Relative length vs alive rivals — drives H2H aggression / dominance signal. */
  function relativeSize(board, you) {
    const myLen = you.length || (you.body && you.body.length) || 1;
    let maxRival = 0;
    let sumRival = 0;
    let nRival = 0;
    const snakes = board.snakes || [];
    for (let s = 0; s < snakes.length; s++) {
      const snake = snakes[s];
      if (snake.id === you.id) continue;
      const len = snake.length || (snake.body && snake.body.length) || 0;
      if (len <= 0) continue;
      nRival++;
      sumRival += len;
      if (len > maxRival) maxRival = len;
    }
    const avgRival = nRival ? sumRival / nRival : 0;
    // -1..+1 vs longest foe; 0 if alone
    const vsMax = nRival ? (myLen - maxRival) / Math.max(myLen, maxRival, 1) : 1;
    const size_advantage = Math.max(0, Math.min(1, (vsMax + 1) / 2));
    const longest = !nRival || myLen > maxRival;
    return {
      length_you: myLen,
      length_max_rival: maxRival,
      length_avg_rival: avgRival,
      rivals: nRival,
      size_advantage,
      longest,
      // 0..1 how much longer we are than the biggest threat (0 if smaller/equal)
      size_lead: nRival && myLen > maxRival ? (myLen - maxRival) / myLen : 0,
    };
  }

  function opponentThreatAt(cell, board, you) {
    const dials = getDials();
    let threat = 0;
    const snakes = board.snakes || [];
    for (let s = 0; s < snakes.length; s++) {
      const snake = snakes[s];
      if (snake.id === you.id) continue;
      const head = snake.head || (snake.body && snake.body[0]);
      if (!head) continue;
      const vel = lastMove(snake);
      // Prefer cells away from where their head is going
      if (vel) {
        const projected = add(head, DELTA[vel]);
        if (key(projected) === key(cell)) threat += 2.5;
        if (manhattan(projected, cell) === 1) threat += 1.2;
      }
      // Head-to-head: same cell next turn
      if (manhattan(head, cell) === 1) {
        const myLen = you.length || (you.body && you.body.length) || 1;
        const theirLen = snake.length || (snake.body && snake.body.length) || 1;
        if (theirLen >= myLen) threat += dials.equal_or_longer_head_threat;
        else threat += dials.shorter_head_threat;
      }
    }
    return threat;
  }

  /**
   * Score a Battlesnake move request. Returns ranked moves + courtship signals.
   * @param {object} gameState - full /move JSON (game, turn, board, you)
   */
  function decide(gameState) {
    const board = gameState.board;
    const you = gameState.you;
    const head = you.head || you.body[0];
    const neckMove = lastMove(you);
    const facing = neckMove || "up";
    const blocked = occupiedSet(board, you, { ignoreYouTail: true });
    // Don't block our own head cell for flood from next cell
    blocked.delete(key(head));

    // Hunger floor + cone/size wiring (cone_panic_v1 from logged games).
    const healthHunger =
      you.health != null ? Math.max(0, Math.min(1, (100 - you.health) / 100)) : 0.5;
    const hunger = Math.max(0.92, healthHunger);
    const dangerNow = minDangerDistance(head, board, you);
    const maxDim = Math.max(board.width, board.height);
    const size = relativeSize(board, you);
    const cone = forwardConeEmpty(board, head, facing, blocked);
    // Safety = empty fraction in the facing cone (visual / egocentric open path).
    const safety = Math.max(0, Math.min(1, cone.ratio));
    // Race when bigger; yield to exclusive fruit when smaller
    const foodTarget = foodRaceOrYield(board, you, head, size);
    const hereEntropy = regionEntropy(board, head, facing, blocked);
    const hereRetina = buildRetina(board, you, facing);
    const hereSectors = sampleSectors(hereRetina);
    const courtship =
      Math.pow(safety, 1.05) *
      (0.35 + 0.3 * Math.min(1, dangerNow / (maxDim * 0.4))) *
      (0.4 + 0.35 * foodTarget.exclusivity + 0.25 * hereEntropy.entropy);
    // Bigger than rivals → lean into risk / H2H; smaller → tuck toward space
    let aggression = 0.5 + 0.5 * size.size_advantage;
    // --- wiring from dials (FsAvatarDials) ---
    const d = getDials();
    const turn = gameState.turn != null ? gameState.turn : 0;
    const early = turn < (d.early_game_turns || 0);
    if (early) aggression = Math.min(aggression, d.early_aggression_cap);
    const health = you.health != null ? you.health : 100;
    const starveUrgency = Math.max(0, Math.min(1, (55 - health) / 55));
    const foodDistNow = foodTarget.myDist != null ? foodTarget.myDist : nearestFoodDist(head, board.food);
    // Panic rare: require tight cone AND snake adjacent, or true tunnel (Rung4 SmartyTree).
    const snakeNear = minSnakeDanger(head, board, you);
    const tunnelThresh = d.panic_tunnel_thresh != null ? d.panic_tunnel_thresh : 0.08;
    const panic =
      ((safety < d.panic_safety_thresh && snakeNear <= d.panic_danger_thresh) ||
        safety < tunnelThresh) &&
      starveUrgency < d.starve_blocks_panic_above;
    const undersized = size.size_advantage < 0.5;
    const dominant = size.size_advantage >= 0.55 || size.longest;
    const lenGap = (size.length_max_rival || 0) - (size.length_you || 0);
    const behind = lenGap >= (d.catchup_len_gap != null ? d.catchup_len_gap : 2);
    // Spatial orchard: abundance + pocket attractor the fly steers toward
    const orchard = orchardScent(board, head);
    const foodCount = orchard.foodCount;
    const foodAbundance = orchard.abundance;
    const orchardSmell = orchard.smell;
    // When racing a specific fruit, blend attractor toward that berry
    let smellTarget = orchard.target;
    if (foodTarget.race && foodTarget.preferred && smellTarget) {
      smellTarget = {
        x: Math.round(0.55 * foodTarget.preferred.x + 0.45 * smellTarget.x),
        y: Math.round(0.55 * foodTarget.preferred.y + 0.45 * smellTarget.y),
      };
    } else if (foodTarget.preferred && !smellTarget) {
      smellTarget = foodTarget.preferred;
    }
    let foodGate = 1;
    if (panic) foodGate *= d.panic_food_gate;
    else if (foodTarget.race) foodGate *= d.race_food_gate;
    else if (undersized) foodGate *= d.undersized_food_gate;
    if (behind) foodGate = Math.max(foodGate, d.catchup_food_gate != null ? d.catchup_food_gate : 1.55);
    if (early) foodGate *= d.early_food_gate_scale;
    if (starveUrgency > 0.35 || (foodDistNow != null && foodDistNow <= 2 && dangerNow > 1.5)) {
      foodGate = Math.max(foodGate, 0.7 + 0.45 * starveUrgency);
    }
    // Yield / contested: still take exclusive orchard — don't let threat veto starve us
    if (!panic && !foodTarget.race && foodTarget.exclusivity > 0.65) {
      foodGate = Math.max(foodGate, 1.25);
    }
    if (
      !foodTarget.race &&
      foodDistNow != null &&
      foodDistNow <= 2 &&
      foodTarget.rivalsCloser < 1 &&
      dangerNow > 1
    ) {
      foodGate = Math.max(foodGate, d.exclusive_near_boost);
    }
    // Abundance aggression: rich board → smell harder (even in yield), soft floor when hungry
    if (!panic && orchardSmell > 0.35) {
      foodGate = Math.max(foodGate, 1.0 + 0.7 * orchardSmell);
    }
    if (starveUrgency > 0.45) {
      foodGate = Math.max(foodGate, 1.15 + 0.5 * orchardSmell);
    }
    const smellBoost = panic ? 1 : 1 + 0.85 * orchardSmell;
    const coneBoost = panic ? 1.7 : undersized ? 1.25 : 1.0;
    const spaceBoost = panic ? 1.35 : undersized ? 1.15 : 1.0;
    const preferred = foodTarget.preferred;
    let foodInCone = false;
    if (preferred) {
      const face = cone.facing;
      const fwd = DELTA[face];
      const right = { x: fwd.y, y: -fwd.x };
      const dx = preferred.x - head.x;
      const dy = preferred.y - head.y;
      const ahead = dx * fwd.x + dy * fwd.y;
      const lat = Math.abs(dx * right.x + dy * right.y);
      foodInCone = ahead > 0 && lat <= ahead;
    }

    const scored = [];
    for (let i = 0; i < MOVES.length; i++) {
      const move = MOVES[i];
      const next = add(head, DELTA[move]);
      const detail = {
        move,
        next,
        legal: true,
        fatal: false,
        space: 0,
        coneEmpty: 0,
        foodPull: 0,
        velocityAvoid: 0,
        danger: 0,
        score: -Infinity,
      };

      if (neckMove && move === OPPOSITE[neckMove]) {
        detail.legal = false;
        detail.fatal = true;
        detail.reason = "neck";
        scored.push(detail);
        continue;
      }
      if (!inBounds(board, next)) {
        detail.legal = false;
        detail.fatal = true;
        detail.reason = "wall";
        scored.push(detail);
        continue;
      }
      if (blocked.has(key(next))) {
        detail.legal = false;
        detail.fatal = true;
        detail.reason = "body";
        scored.push(detail);
        continue;
      }

      const onFood = (board.food || []).some((f) => f.x === next.x && f.y === next.y);
      const blockedNext = blockedAfterMove(board, you, next, onFood);
      const space = floodFill(board, next, blockedNext);
      const coneNext = forwardConeEmpty(board, next, move, blockedNext);
      const entNext = regionEntropy(board, next, move, blockedNext);
      const youNext = { id: you.id, length: you.length, body: you.body, head: next };
      const sec = sampleSectors(buildRetina(board, youNext, move));
      // Pull toward preferred fruit (race target if bigger, exclusive if smaller)
      const foodDist = preferred
        ? manhattan(next, preferred)
        : nearestFoodDist(next, board.food);
      const foodPull = foodDist == null ? 0 : 1 / (1 + foodDist);
      let velThreat = opponentThreatAt(next, board, you);
      // Racing softens H2H fear only when dial allows (1.0 = never soften)
      if (foodTarget.race) velThreat *= d.race_threat_soften;
      const cellDanger = minDangerDistance(next, board, you);
      const snakeDanger = minSnakeDanger(next, board, you);
      const selfNear = minSelfBodyDist(next, you, !onFood);
      // Fruit veto: snake danger only — walls must not make food look like a wall
      let fruitHard = snakeDanger <= d.fruit_hard_danger;
      let fruitSoft = !fruitHard && (snakeDanger <= d.fruit_soft_danger || sec.threat > 0.5);
      let fruitScale = fruitHard ? 0 : fruitSoft ? d.fruit_soft_scale : 1;
      if (onFood && d.food_cell_commits_bite !== false) {
        const myLen = you.length || (you.body && you.body.length) || 1;
        let headAdjEq = false;
        const snakes = board.snakes || [];
        for (let s = 0; s < snakes.length; s++) {
          const snake = snakes[s];
          if (snake.id === you.id) continue;
          const sh = snake.head || (snake.body && snake.body[0]);
          if (!sh) continue;
          const theirLen = snake.length || (snake.body && snake.body.length) || 1;
          if (manhattan(next, sh) === 1 && theirLen >= myLen) {
            headAdjEq = true;
            break;
          }
        }
        if (!headAdjEq) {
          fruitHard = false;
          fruitSoft = false;
          fruitScale = 1;
        }
      }

      const dangerScore = cellDanger / maxDim;
      let spaceScore = space / (board.width * board.height);
      const myLenI = you.length || (you.body && you.body.length) || 1;
      const nextLen = myLenI + (onFood ? 1 : 0);
      const fitMargin = d.pocket_fit_margin != null ? d.pocket_fit_margin : 3;
      const pocketOk = space >= nextLen + fitMargin;
      const foodPocketVeto =
        onFood &&
        d.food_requires_pocket_fit !== false &&
        !pocketOk &&
        starveUrgency < (d.food_pocket_starve_override != null ? d.food_pocket_starve_override : 0.7);
      if (foodPocketVeto) {
        /* damp below */
      }
      const spaceLenW =
        1 + (d.long_body_space_weight || 0) * Math.min(1, Math.max(0, (nextLen - 8) / 20));
      if (!pocketOk) spaceScore *= d.tight_pocket_penalty != null ? d.tight_pocket_penalty : 0.12;
      const selfHugW =
        (d.self_hug_penalty != null ? d.self_hug_penalty : 1.8) *
        Math.min(1, Math.max(0, (nextLen - 10) / 12));
      let selfHug = 0;
      if (selfNear <= 1) selfHug = selfHugW * (selfNear <= 0 ? 1.2 : 1);
      else if (selfNear <= 2) selfHug = 0.35 * selfHugW;
      const coneScore = coneNext.ratio;
      const foodWeight =
        0.7 +
        1.1 * hunger +
        0.2 * courtship +
        0.35 * size.size_advantage +
        0.6 * starveUrgency +
        0.55 * orchardSmell +
        (foodTarget.race ? 0.7 : 0.4 * foodTarget.exclusivity);
      let foodScore =
        fruitScale *
        smellBoost *
        foodPull *
        foodWeight *
        (0.75 + 0.25 * safety) *
        foodGate *
        (foodInCone ? 1.15 : 1) *
        (foodTarget.race ? 1.2 : 0.75 + 0.45 * foodTarget.exclusivity);
      if (onFood && !fruitHard) foodScore *= d.bite_commit_boost || 1.75;
      if (foodPocketVeto) foodScore *= 0.02;
      const velocityAvoid = -velThreat * (1 - 0.45 * aggression);
      const conePrefer = 2.4 * coneScore * coneBoost;
      const entropyPrefer = 2.8 * entNext.entropy;
      // Keep ≥0.75× threat weight even when dominant+racing
      const threatW = (dominant && foodTarget.race ? 0.75 : 1) * 3.2;
      const retinaPrefer =
        2.0 * sec.open +
        fruitScale * smellBoost * 2.2 * sec.fruit * foodGate -
        threatW * sec.threat +
        1.6 * sec.entropy;
      // Panic open bias — ease off when exclusive fruit / on food
      const exclusiveSnack =
        !foodTarget.race &&
        foodDistNow != null &&
        foodDistNow <= 2 &&
        foodTarget.rivalsCloser < 1 &&
        foodTarget.exclusivity > 0.6;
      const biteOverride = d.bite_override_panic !== false && (exclusiveSnack || onFood);
      const panicOpen =
        panic && !biteOverride ? 3.5 * sec.open + 0.05 * coneNext.empty : panic ? 1.2 * sec.open : 0;
      // Climb the scent gradient — smell is not zeroed by wall-as-fruit-hard
      const scentNext = orchard.scentAt(next);
      const scentDelta = scentNext - orchard.scentHere;
      const distHead = smellTarget ? manhattan(head, smellTarget) : null;
      const distNext = smellTarget ? manhattan(next, smellTarget) : null;
      const towardPocket =
        distHead != null && distNext != null ? 1 / (1 + distNext) - 1 / (1 + distHead) : 0;
      let smellScale =
        onFood && !fruitHard ? 1 : Math.max(fruitScale, d.smell_min_scale != null ? d.smell_min_scale : 0.6);
      if (fruitHard && !onFood) smellScale = d.smell_min_scale != null ? d.smell_min_scale : 0.6;
      const scentPrefer =
        (panic ? d.smell_panic_dampen : 1) *
        smellBoost *
        smellScale *
        (2.8 * Math.max(0, scentDelta) + 2.2 * Math.max(0, towardPocket) + 0.55 * scentNext);

      detail.space = space;
      detail.coneEmpty = coneNext.empty;
      detail.foodPull = foodPull;
      detail.velocityAvoid = velocityAvoid;
      detail.danger = cellDanger;
      detail.foodExclusivity = foodTarget.exclusivity;
      detail.entropy = entNext.entropy;
      detail.retinaOpen = sec.open;
      detail.retinaFruit = sec.fruit;
      detail.retinaThreat = sec.threat;
      detail.sectorEntropy = sec.entropy;
      detail.fruitHard = fruitHard;
      detail.onFood = onFood;
      detail.pocketOk = pocketOk;
      detail.foodPocketVeto = foodPocketVeto;
      detail.selfNear = Number.isFinite(selfNear) ? selfNear : null;
      detail.fruitSoft = fruitSoft;
      detail.fruitScale = fruitScale;
      detail.scentNext = scentNext;
      detail.scentDelta = scentDelta;
      detail.towardPocket = towardPocket;
      detail.score =
        (5.0 - 1.5 * aggression) * (detail.fatal ? -10 : dangerScore) +
        1.6 * spaceScore * spaceBoost * spaceLenW +
        conePrefer +
        entropyPrefer +
        retinaPrefer +
        scentPrefer +
        panicOpen +
        1.3 * velocityAvoid +
        (7.5 + 3.0 * hunger + 2.5 * starveUrgency + (foodTarget.race ? 2.5 : 1.5 * foodTarget.exclusivity)) *
          foodScore +
        0.45 * courtship * spaceScore +
        (dominant && !panic ? 0.6 * size.size_lead * foodPull : 0) -
        selfHug;

      scored.push(detail);
    }

    const legalAll = scored.filter((s) => s.legal && !s.fatal);
    const fitting = legalAll.filter((s) => s.pocketOk !== false);
    let legal = fitting.length ? fitting : legalAll;
    const nonFoodTrap = legal.filter((s) => !s.foodPocketVeto);
    if (nonFoodTrap.length) legal = nonFoodTrap;
    legal.sort((a, b) => b.score - a.score || (b.space || 0) - (a.space || 0));
    const pick = legal.length ? legal[0].move : (neckMove && OPPOSITE[neckMove]) || "up";
    const pickSec = legal.length ? legal[0] : null;
    const eyesOpen = pickSec && pickSec.retinaOpen != null ? pickSec.retinaOpen : hereSectors.open;
    const eyesFruit = pickSec && pickSec.retinaFruit != null ? pickSec.retinaFruit : hereSectors.fruit;
    const eyesThreat = pickSec && pickSec.retinaThreat != null ? pickSec.retinaThreat : hereSectors.threat;
    const eyesEntropy =
      pickSec && pickSec.sectorEntropy != null ? pickSec.sectorEntropy : hereSectors.entropy;
    const threatVetoesFruit = eyesThreat > 0.42 && eyesFruit > 0.04 && eyesThreat > eyesOpen;
    const openWins = eyesOpen > 0.45 && eyesOpen > eyesFruit + 0.15 && eyesThreat < 0.28;

    return {
      move: pick,
      shout: starveUrgency > 0.5
        ? "starving — hunt"
        : panic
          ? "escape cone!"
          : orchardSmell > 0.55 && !foodTarget.race
            ? "orchard smell — feast"
            : threatVetoesFruit
              ? "eyes say danger"
              : openWins && !foodTarget.race
                ? "eyes say space"
                : foodTarget.race
                  ? "racing fruit — bigger"
                  : foodTarget.exclusivity > 0.7 && !foodTarget.contested
                    ? "courting free fruit"
                    : foodTarget.contested && foodTarget.exclusivity < 0.45
                      ? "skipping contested fruit"
                      : hereEntropy.entropy > 0.55
                        ? "seeking open entropy"
                        : foodInCone && foodDistNow != null && foodDistNow <= 2
                          ? "fruit in view"
                          : courtship > 0.65
                            ? "courting the open board"
                            : size.longest && size.size_lead > 0.15
                              ? "outgrowing the board"
                              : courtship < 0.25
                                ? "danger!"
                                : "",
      scored,
      signals: {
        courtship,
        safety,
        hunger,
        danger_distance: dangerNow,
        food_distance: foodDistNow,
        space_best: legal.length ? legal[0].space : 0,
        cone_empty: cone.empty,
        cone_capacity: cone.capacity,
        cone_ratio: cone.ratio,
        facing: cone.facing,
        length_you: size.length_you,
        length_max_rival: size.length_max_rival,
        size_advantage: size.size_advantage,
        size_lead: size.size_lead,
        longest: size.longest,
        panic,
        food_gate: foodGate,
        health,
        starve_urgency: starveUrgency,
        food_in_cone: foodInCone,
        food_count: foodCount,
        food_abundance: foodAbundance,
        orchard_smell: orchardSmell,
        smell_boost: smellBoost,
        smell_target: smellTarget,
        scent_here: orchard.scentHere,
        cluster_mass: orchard.clusterMass,
        food_exclusivity: foodTarget.exclusivity,
        food_contested: foodTarget.contested,
        food_rivals_closer: foodTarget.rivalsCloser,
        food_rivals_heading: foodTarget.rivalsHeading,
        preferred_food: preferred,
        food_mode: foodTarget.mode,
        food_race: !!foodTarget.race,
        region_entropy: hereEntropy.entropy,
        mobility_entropy: hereEntropy.mobility,
        fruit_entropy: hereEntropy.fruit,
        retina_open: hereSectors.open,
        retina_fruit: hereSectors.fruit,
        retina_threat: hereSectors.threat,
        sector_entropy: eyesEntropy,
        wiring: d.wiring || "retina_sectors_v1_orchard",
        dials_id: d.id,
        neuron_targets: {
          courtship_pC1: panic ? courtship * 0.25 : courtship,
          courtship_vPR6: courtship * foodTarget.exclusivity * (1 - hunger) * (panic ? 0.15 : 1),
          ALPN: 0.35 + 0.55 * (1 - safety) + 0.35 * hereSectors.threat + (panic ? 0.2 : 0),
          DAN:
            0.15 +
            0.3 * hunger * Math.max(safety, 0.35) +
            0.2 * courtship +
            0.25 * size.size_advantage +
            0.45 * starveUrgency +
            0.55 * orchardSmell +
            (foodTarget.race ? 0.45 : 0.25 * foodTarget.exclusivity) +
            (foodInCone ? 0.15 : 0) +
            0.35 * hereSectors.fruit +
            (foodDistNow != null && foodDistNow <= 2 ? 0.2 : 0),
          MBON: 0.15 + 0.25 * safety + 0.4 * hereSectors.open + 0.35 * hereEntropy.entropy + (panic ? 0.1 : 0),
          DAN_risk: foodTarget.race ? Math.max(size.size_advantage, 0.7) : size.size_advantage * (panic ? 0.3 : 1) * (1 + 0.3 * orchardSmell),
          aSPIC: size.size_lead,
          KC_escape: panic ? 0.85 : Math.max(0, 1 - safety) * 0.35 + 0.4 * hereSectors.threat,
        },
      },
    };
  }

  global.FsAvatarPolicy = {
    MOVES,
    DELTA,
    decide,
    getDials,
    DEFAULT_DIALS,
    lastMove,
    manhattan,
    minDangerDistance,
    forwardConeEmpty,
    relativeSize,
    foodCourtshipTargets,
    foodRaceOrYield,
    regionEntropy,
    orchardScent,
    buildRetina,
    sampleSectors,
  };
})(typeof window !== "undefined" ? window : globalThis);
