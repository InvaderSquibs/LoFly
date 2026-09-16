/**
 * Lightweight Battlesnake-like local engine for FS-Avatar demos.
 * Simultaneous moves, food, growth, head-to-head by length, health.
 */
(function (global) {
  "use strict";

  const DELTA = global.FsAvatarPolicy
    ? global.FsAvatarPolicy.DELTA
    : { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

  function uid(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 10);
  }

  function clonePos(p) {
    return { x: p.x, y: p.y };
  }

  function key(p) {
    return p.x + "," + p.y;
  }

  function randomEmpty(width, height, taken) {
    const free = [];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const k = x + "," + y;
        if (!taken.has(k)) free.push({ x, y });
      }
    }
    if (!free.length) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  function makeSnake(name, color, start, length) {
    const body = [];
    for (let i = 0; i < length; i++) {
      body.push({ x: start.x, y: Math.max(0, start.y - i) });
    }
    return {
      id: uid("gs"),
      name,
      health: 100,
      body: body.map(clonePos),
      head: clonePos(body[0]),
      length: body.length,
      customizations: { color, head: "default", tail: "default" },
      shout: "",
      eliminated: false,
      eliminationCause: null,
    };
  }

  function createGame(opts) {
    opts = opts || {};
    const width = opts.width || 11;
    const height = opts.height || 11;
    const youName = opts.youName || "Walton-LoFly-v0.1";
    const youColor = opts.youColor || "#f0b429";

    const starts = [
      { x: 1, y: Math.floor(height / 2) },
      { x: width - 2, y: Math.floor(height / 2) },
      { x: Math.floor(width / 2), y: height - 2 },
      { x: Math.floor(width / 2), y: 1 },
    ];

    const you = makeSnake(youName, youColor, starts[0], 3);
    const opponents = [
      makeSnake("Rival-A", "#52c7e0", starts[1], 3),
      makeSnake("Rival-B", "#ef6a61", starts[2], 3),
    ];
    if (opts.nOpponents === 1) opponents.length = 1;
    if (opts.nOpponents === 0) opponents.length = 0;

    const snakes = [you].concat(opponents);
    const taken = new Set();
    snakes.forEach((s) => s.body.forEach((p) => taken.add(key(p))));

    const food = [];
    const nFood = opts.food || 3;
    for (let i = 0; i < nFood; i++) {
      const p = randomEmpty(width, height, taken);
      if (!p) break;
      food.push(p);
      taken.add(key(p));
    }

    return {
      game: {
        id: uid("game"),
        ruleset: { name: "standard", version: "fs-avatar-local" },
        timeout: 500,
      },
      turn: 0,
      board: { height, width, food, hazards: [], snakes },
      you,
      youId: you.id,
      over: false,
      winnerId: null,
      log: [],
    };
  }

  function aliveSnakes(state) {
    return state.board.snakes.filter((s) => !s.eliminated);
  }

  function simpleBotMove(state, snake) {
    // Greedy: avoid immediate death, else prefer food / random
    const policy = global.FsAvatarPolicy;
    if (!policy) return "up";
    const fakeYou = snake;
    const decision = policy.decide({
      game: state.game,
      turn: state.turn,
      board: state.board,
      you: fakeYou,
    });
    // Nudge bots to be slightly hungrier / less courtship-aware via re-pick
    return decision.move;
  }

  function applyMoves(state, moveById) {
    if (state.over) return state;

    const board = state.board;
    const snakes = aliveSnakes(state);
    const intended = {};

    snakes.forEach((s) => {
      const move = moveById[s.id] || "up";
      const d = DELTA[move] || DELTA.up;
      const nextHead = { x: s.head.x + d.x, y: s.head.y + d.y };
      intended[s.id] = { move, nextHead, snake: s };
    });

    // Resolve positions
    Object.keys(intended).forEach((id) => {
      const { nextHead, snake } = intended[id];
      // Out of bounds
      if (
        nextHead.x < 0 ||
        nextHead.y < 0 ||
        nextHead.x >= board.width ||
        nextHead.y >= board.height
      ) {
        snake.eliminated = true;
        snake.eliminationCause = "wall";
        return;
      }
      snake.body = [clonePos(nextHead)].concat(snake.body);
      snake.head = clonePos(nextHead);
      snake.health = Math.max(0, snake.health - 1);
    });

    // Food
    const remainingFood = [];
    board.food.forEach((f) => {
      let eaten = false;
      aliveSnakes(state).forEach((s) => {
        if (s.head.x === f.x && s.head.y === f.y) {
          s.health = 100;
          s.ate = true;
          eaten = true;
        }
      });
      if (!eaten) remainingFood.push(f);
    });
    board.food = remainingFood;

    // Trim tails (unless ate)
    aliveSnakes(state).forEach((s) => {
      if (s.ate) {
        s.ate = false;
      } else if (s.body.length > 1) {
        s.body.pop();
      }
      s.length = s.body.length;
    });

    // Collisions: body + head-to-head
    const bodyOcc = new Map(); // cell -> [snakeIds] for bodies excluding heads first
    aliveSnakes(state).forEach((s) => {
      for (let i = 1; i < s.body.length; i++) {
        const k = key(s.body[i]);
        if (!bodyOcc.has(k)) bodyOcc.set(k, []);
        bodyOcc.get(k).push(s.id);
      }
    });

    // Self / body collisions
    aliveSnakes(state).forEach((s) => {
      const k = key(s.head);
      // self body
      for (let i = 1; i < s.body.length; i++) {
        if (s.body[i].x === s.head.x && s.body[i].y === s.head.y) {
          s.eliminated = true;
          s.eliminationCause = "self";
          return;
        }
      }
      // other body
      const hits = bodyOcc.get(k) || [];
      if (hits.some((id) => id !== s.id)) {
        s.eliminated = true;
        s.eliminationCause = "body";
      }
    });

    // Head-to-head
    const headCells = new Map();
    aliveSnakes(state).forEach((s) => {
      const k = key(s.head);
      if (!headCells.has(k)) headCells.set(k, []);
      headCells.get(k).push(s);
    });
    headCells.forEach((group) => {
      if (group.length < 2) return;
      const maxLen = Math.max(...group.map((s) => s.length));
      group.forEach((s) => {
        if (s.length < maxLen) {
          s.eliminated = true;
          s.eliminationCause = "head-to-head";
        } else if (group.filter((g) => g.length === maxLen).length > 1) {
          // equal length — all die
          s.eliminated = true;
          s.eliminationCause = "head-to-head";
        }
      });
    });

    // Starvation
    aliveSnakes(state).forEach((s) => {
      if (s.health <= 0) {
        s.eliminated = true;
        s.eliminationCause = "starvation";
      }
    });

    // Spawn food occasionally
    if (board.food.length < 2 && Math.random() < 0.35) {
      const taken = new Set();
      board.snakes.forEach((s) => {
        if (s.eliminated) return;
        s.body.forEach((p) => taken.add(key(p)));
      });
      board.food.forEach((f) => taken.add(key(f)));
      const p = randomEmpty(board.width, board.height, taken);
      if (p) board.food.push(p);
    }

    // Refresh you pointer
    state.you = board.snakes.find((s) => s.id === state.youId) || state.you;
    state.turn += 1;

    const living = aliveSnakes(state);
    if (living.length <= 1) {
      state.over = true;
      state.winnerId = living.length === 1 ? living[0].id : null;
    } else if (state.you.eliminated) {
      // Keep going briefly for spectacle, or end
      state.over = true;
      state.winnerId = living.length ? living[0].id : null;
    }

    return state;
  }

  function toMoveRequest(state) {
    const snakes = state.board.snakes
      .filter((s) => !s.eliminated)
      .map((s) => ({
        id: s.id,
        name: s.name,
        health: s.health,
        body: s.body.map(clonePos),
        head: clonePos(s.head),
        length: s.length,
        shout: s.shout || "",
        customizations: s.customizations,
      }));
    const you = snakes.find((s) => s.id === state.youId);
    return {
      game: state.game,
      turn: state.turn,
      board: {
        height: state.board.height,
        width: state.board.width,
        food: state.board.food.map(clonePos),
        hazards: (state.board.hazards || []).map(clonePos),
        snakes,
      },
      you: you || {
        id: state.youId,
        name: state.you.name,
        health: 0,
        body: [],
        head: { x: 0, y: 0 },
        length: 0,
      },
    };
  }

  function step(state, youMove) {
    const moves = {};
    aliveSnakes(state).forEach((s) => {
      if (s.id === state.youId) {
        moves[s.id] = youMove;
      } else {
        moves[s.id] = simpleBotMove(state, s);
      }
    });
    return applyMoves(state, moves);
  }

  global.FsAvatarGame = {
    createGame,
    step,
    toMoveRequest,
    aliveSnakes,
  };
})(window);
