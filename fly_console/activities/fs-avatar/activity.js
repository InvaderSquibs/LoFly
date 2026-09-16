/**
 * FS-Avatar — fly steers a Battlesnake via policy; joystick is theater.
 *
 * Real control path: FsAvatarPolicy.decide → {"move": ...} (same as POST /move).
 * Local sim plays immediately; optional game-id iframe watches a real match.
 * Signals (courtship, danger, hunger, space) are exposed for later neuron wiring.
 */
(function (global) {
  "use strict";

  const FS_BASE = "activities/fs-avatar/";
  const FLY_GIF = "activities/fx/assets/fly_topdown.gif?v=3";
  const FLY_SIZE = 48;
  const N_BINS = 50;
  const CELL = 22;
  const API_DEFAULT = "http://127.0.0.1:8001";
  const CHAIN_TARGET_DEFAULT = 20; // bump to 100 once a 20-batch looks healthy
  let chainTarget = CHAIN_TARGET_DEFAULT;

  let live = null;
  let runToken = 0;
  let stickPose = { x: 0, y: 0 }; // -1..1 stick deflection
  let pollTimer = 0;
  let lastSeenTurn = null;
  let lastHandledGameId = null;
  let lastEndedGameId = null;
  let playOpts = { multi: false };
  let chainActive = false; // auto-start next game after end (Solo / Vs rivals)
  let chainPlayed = 0; // completed games in current batch
  let pollBusy = false;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src + (src.indexOf("?") >= 0 ? "&" : "?") + "v=1";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  function emptyCurves() {
    const z = () => Array(N_BINS).fill(0);
    return { ALPN: z(), Kenyon_Cell: z(), MBON: z(), DAN: z() };
  }

  /**
   * Egocentric board raster for the optic-lobe hex map.
   * Forward = current facing (last move). Food = fruit red; foes = cyan→coral by proximity.
   */
  function boardToVisual(req, facing) {
    if (!req || !req.board || !req.you) return null;
    const board = req.board;
    const you = req.you;
    const head = you.head || (you.body && you.body[0]);
    if (!head) return null;
    const w = board.width;
    const h = board.height;
    const face = facing || "up";
    const fwd =
      face === "up"
        ? { x: 0, y: 1 }
        : face === "down"
          ? { x: 0, y: -1 }
          : face === "left"
            ? { x: -1, y: 0 }
            : { x: 1, y: 0 };
    const right = { x: fwd.y, y: -fwd.x };

    const foodSet = new Set((board.food || []).map((p) => p.x + "," + p.y));
    const myLen = you.length || (you.body && you.body.length) || 1;
    const foeCells = new Map(); // key -> { col, hot, isHead }
    (board.snakes || []).forEach((s, si) => {
      if (s.id === you.id) return;
      const col = si % 2 === 0 ? [82, 199, 224] : [239, 106, 97];
      const len = s.length || (s.body && s.body.length) || 1;
      const hot = 0.6 + 0.4 * Math.min(1, len / Math.max(myLen, 1));
      (s.body || []).forEach((p, i) => {
        foeCells.set(p.x + "," + p.y, { col, hot, isHead: i === 0 });
      });
    });
    const youSet = new Set((you.body || []).map((p) => p.x + "," + p.y));

    // View: ahead-heavy strip in egocentric coords
    const viewW = Math.min(15, w * 2 - 1);
    const viewH = Math.min(15, h * 2 - 1);
    const halfW = (viewW - 1) >> 1;
    const rgba = new Uint8ClampedArray(viewW * viewH * 4);

    for (let vy = 0; vy < viewH; vy++) {
      for (let vx = 0; vx < viewW; vx++) {
        const egX = vx - halfW; // right positive
        const egY = viewH - 1 - vy; // forward up the image
        const wx = head.x + egX * right.x + egY * fwd.x;
        const wy = head.y + egX * right.y + egY * fwd.y;
        const i = (vy * viewW + vx) * 4;
        let r = 18,
          g = 17,
          b = 15,
          a = 255;
        if (wx < 0 || wy < 0 || wx >= w || wy >= h) {
          r = 8;
          g = 8;
          b = 10;
        } else {
          const k = wx + "," + wy;
          const inCone = egY >= 1 && Math.abs(egX) <= egY;
          if (foodSet.has(k)) {
            r = 236;
            g = inCone ? 88 : 72;
            b = 72; // fruit — brighter in cone
          } else if (foeCells.has(k)) {
            const foe = foeCells.get(k);
            const c = foe.col;
            const dist = Math.abs(egX) + Math.abs(egY);
            const prox = Math.max(0.35, 1 - dist / 10) * foe.hot * (foe.isHead ? 1.25 : 1);
            r = Math.round(c[0] * prox + 30 * (1 - prox));
            g = Math.round(c[1] * prox + 20 * (1 - prox));
            b = Math.round(c[2] * prox + 20 * (1 - prox));
          } else if (youSet.has(k)) {
            r = 240;
            g = 180;
            b = 41; // self
          } else if (wx === head.x && wy === head.y) {
            r = 255;
            g = 220;
            b = 80;
          } else {
            // open: greenish, brighter inside the forward cone MBON sees
            const open = Math.min(1, egY / viewH);
            const coneBoost = inCone ? 1 : 0.45;
            r = 18 + (inCone ? 8 : 0);
            g = 24 + Math.round(38 * open * coneBoost);
            b = 22 + Math.round(10 * coneBoost);
          }
        }
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = a;
      }
    }
    return { w: viewW, h: viewH, rgba };
  }

  function pushEyes(hooks, req, facing) {
    const panel = hooks && hooks.eyemapPanel;
    if (!panel) return;
    const img = boardToVisual(req, facing);
    if (!img) return;
    if (typeof panel.setMode === "function") panel.setMode("visual");
    if (typeof panel.setVisualImage === "function") panel.setVisualImage(img);
    if (typeof panel.setActive === "function") panel.setActive(true);
  }

  function synthState(signals, frac, visual) {
    const f = Math.max(0, Math.min(1, frac));
    const n = (signals && signals.neuron_targets) || {};
    const curves = emptyCurves();
    for (let i = 0; i < N_BINS; i++) {
      const t = i / (N_BINS - 1);
      const gate = t <= f ? 1 : 0.1;
      const wave = Math.sin(t * Math.PI);
      curves.ALPN[i] = (10 + 55 * (n.ALPN || 0.4) * wave) * gate;
      curves.Kenyon_Cell[i] = (8 + 50 * (n.KC_escape != null ? n.KC_escape : 0.4) * wave) * gate;
      curves.MBON[i] = (6 + 45 * (n.MBON || 0.3) * wave) * gate;
      curves.DAN[i] = (5 + 60 * (n.DAN || 0.3) * wave) * gate;
    }
    const idx = Math.min(N_BINS - 1, Math.floor(f * (N_BINS - 1)));
    return {
      rate_curves: curves,
      raster: { ALPN: [], Kenyon_Cell: [], MBON: [], DAN: [] },
      alpn_rate: curves.ALPN[idx],
      kc_rate: curves.Kenyon_Cell[idx],
      mbon_rate: curves.MBON[idx],
      dan_rate: curves.DAN[idx],
      visual_image: visual || null,
      activity_payload: { signals },
    };
  }

  function pushBrain(hooks, signals, frac, visual) {
    const state = synthState(signals, frac, visual);
    if (hooks.cascadeSvg && global.FlyExperience) {
      global.FlyExperience.setStreamContext({
        cascadeSvg: hooks.cascadeSvg,
        rasterSvg: hooks.rasterSvg,
        legendEl: hooks.legendEl,
        stateData: state,
        meta: hooks.meta,
        streamFrac: frac,
        onProgress: (pf, sliced) => {
          if (hooks.driveAnatomy) hooks.driveAnatomy(sliced || state);
        },
      });
      global.FlyExperience.setStreamProgress(frac);
    }
    if (hooks.driveAnatomy) hooks.driveAnatomy(state);
    return state;
  }

  function chromeHtml() {
    return `
      <div class="fs-chrome">
        <div class="fs-stage">
          <div class="fs-board-wrap">
            <div class="fs-you-pill" id="fsYouPill">YOU · Walton-LoFly-v0.1</div>
            <div class="fs-outcome-pill" id="fsOutcomePill" hidden></div>
            <svg class="fs-board" id="fsBoard" viewBox="0 0 260 260" aria-label="Battlesnake board"></svg>
            <div class="fs-iframe-host" id="fsIframeHost" hidden>
              <iframe class="fs-iframe" id="fsIframe" title="Battlesnake board viewer" sandbox="allow-scripts allow-same-origin"></iframe>
            </div>
          </div>
          <div class="fs-cockpit" id="fsCockpit">
            <div class="fs-stick-well" id="fsStickWell">
              <div class="fs-stick-base"></div>
              <div class="fs-stick" id="fsStick">
                <div class="fs-stick-knob"></div>
              </div>
              <div class="fs-fly" id="fsFly" aria-hidden="true">
                <img class="fs-fly-img" src="${FLY_GIF}" width="${FLY_SIZE}" height="${FLY_SIZE}" alt=""/>
              </div>
              <div class="fs-stick-labels">
                <span class="fs-dir up">UP</span>
                <span class="fs-dir down">DOWN</span>
                <span class="fs-dir left">LEFT</span>
                <span class="fs-dir right">RIGHT</span>
              </div>
            </div>
            <div class="fs-move-readout mono" id="fsMoveReadout">move: —</div>
          </div>
        </div>
        <div class="fs-side">
          <div class="fs-toolbar">
            <button type="button" class="fs-run" id="fsStartApi">▶ Solo ×20</button>
            <button type="button" class="fs-run" id="fsStartMulti">▶ Vs rivals ×20</button>
            <button type="button" class="fs-run fs-secondary" id="fsPlay">Local sim</button>
            <button type="button" class="fs-run fs-secondary" id="fsPause">Pause</button>
            <button type="button" class="fs-run fs-secondary" id="fsReset">Reset sim</button>
          </div>
          <div class="mono fs-status" id="fsStatus">idle</div>
          <div class="fs-api-stack">
            <div class="cap">server api endpoint</div>
            <div class="fs-api-row">
              <input class="fs-input mono" id="fsApiUrl" value="${API_DEFAULT}" title="FS-Avatar webhook base URL" />
              <span class="mono fs-api-pill" id="fsApiPill">api: …</span>
            </div>
            <div class="fs-public mono" id="fsPublicUrl" hidden></div>
          </div>
          <div class="fs-side-grid">
            <div class="fs-signals" id="fsSignals">
              <div class="cap">signals · neuron hooks</div>
              <div class="fs-meters" id="fsMeters"></div>
            </div>
            <div class="fs-score-wrap">
              <div class="cap">move scores</div>
              <div class="fs-scores mono" id="fsScores"></div>
            </div>
          </div>
          <div class="fs-secondary-row">
            <div class="fs-log-wrap">
              <div class="cap">turn log</div>
              <ol class="fs-log mono" id="fsLog"></ol>
            </div>
            <div class="fs-review-wrap">
              <div class="cap">batch · risk / reward → neurons</div>
              <div class="fs-toolbar" style="margin-bottom:6px">
                <button type="button" class="fs-run fs-secondary" id="fsReview">Review last</button>
                <button type="button" class="fs-run fs-secondary" id="fsReviewBatch">Review batch</button>
              </div>
              <div class="fs-review mono" id="fsReviewBody">Run a ×20 batch (Solo / Vs rivals), then evaluate — transcripts in activities/fs-avatar/logs/.</div>
            </div>
          </div>
          <div class="fs-watch-wrap">
            <div class="cap">board.battlesnake.com iframe (optional replay)</div>
            <div class="fs-watch-row">
              <input class="fs-input mono" id="fsGameId" placeholder="game uuid or play.battlesnake.com/game/… URL" />
              <button type="button" class="fs-run fs-secondary" id="fsWatch">Watch</button>
              <button type="button" class="fs-run fs-secondary" id="fsLocal">Board</button>
            </div>
            <p class="fs-hint"><strong>Vs rivals</strong> = 3-snake standard game (you + local bots). To fight <em>real people</em>, register the public tunnel URL on <a href="https://play.battlesnake.com/account/battlesnakes" target="_blank" rel="noopener">play.battlesnake.com</a> (name must include your last name), then join a tournament or custom game.</p>
          </div>
        </div>
      </div>`;
  }

  function ensureChrome(slot) {
    slot.innerHTML = chromeHtml();
    slot.dataset.fsReady = "1";
    delete slot.dataset.tttReady;
    delete slot.dataset.percReady;
    delete slot.dataset.fxReady;
  }

  function setStatus(msg) {
    const el = document.getElementById("fsStatus");
    if (el) el.textContent = msg;
  }

  function logTurn(text, kind) {
    const log = document.getElementById("fsLog");
    if (!log) return;
    const li = document.createElement("li");
    li.className = "fs-log-item " + (kind || "");
    li.textContent = text;
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 40) log.removeChild(log.lastChild);
  }

  function boardSvg() {
    return document.getElementById("fsBoard");
  }

  /** Battlesnake board: (0,0) bottom-left → SVG y flips. */
  function renderBoard(state) {
    const svg = boardSvg();
    if (!svg || !state) return;
    const w = state.board.width;
    const h = state.board.height;
    const pad = 8;
    const size = pad * 2 + Math.max(w, h) * CELL;
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    const yFlip = (y) => pad + (h - 1 - y) * CELL;
    const youId = state.youId || (state.you && state.you.id);

    const parts = [];
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        parts.push(
          `<rect class="fs-cell" id="fs-grid-${x}-${y}" x="${pad + x * CELL}" y="${yFlip(y)}" width="${CELL - 1}" height="${CELL - 1}" />`
        );
      }
    }
    (state.board.food || []).forEach((f, i) => {
      parts.push(
        `<circle class="fs-food" id="fs-food-${i}" cx="${pad + f.x * CELL + (CELL - 1) / 2}" cy="${yFlip(f.y) + (CELL - 1) / 2}" r="5" />`
      );
    });

    (state.board.snakes || [])
      .filter((s) => !s.eliminated)
      .forEach((s) => {
        const isYou = s.id === youId;
        const color = (s.customizations && s.customizations.color) || (isYou ? "#f0b429" : "#888");
        const cls = isYou ? "fs-snake fs-snake-you" : "fs-snake";
        const body = s.body || [];
        body.forEach((p, i) => {
          const cx = pad + p.x * CELL + (CELL - 1) / 2;
          const cy = yFlip(p.y) + (CELL - 1) / 2;
          if (i === 0) {
            parts.push(
              `<circle class="${cls} fs-head" data-snake="${s.id}" cx="${cx}" cy="${cy}" r="8" fill="${color}" />`
            );
            if (isYou) {
              parts.push(
                `<text class="fs-you-label" x="${cx}" y="${cy - 12}" text-anchor="middle">YOU</text>`
              );
            }
          } else {
            parts.push(
              `<rect class="${cls}" data-snake="${s.id}" x="${cx - 6}" y="${cy - 6}" width="12" height="12" rx="2" fill="${color}" opacity="${Math.max(0.35, 1 - i * 0.04)}" />`
            );
          }
        });
      });

    svg.innerHTML = parts.join("");
    const pill = document.getElementById("fsYouPill");
    const you = state.you || (state.board.snakes || []).find((s) => s.id === youId);
    if (pill && you) {
      pill.textContent = `YOU · ${you.name || "Walton-LoFly-v0.1"}`;
      pill.style.borderColor = (you.customizations && you.customizations.color) || "#f0b429";
    }
  }

  /** Mirror a live Battlesnake /move (or /end) request into our board chrome. */
  function renderFromApiRequest(req, youOverride) {
    if (!req || !req.board) return;
    const you = youOverride || req.you;
    // On /end, eliminated snakes are often omitted from board.snakes — keep YOU visible.
    const snakes = (req.board.snakes || []).slice();
    if (you && you.id && !snakes.some((s) => s.id === you.id)) {
      snakes.push(
        Object.assign({}, you, {
          eliminated: false,
          customizations: you.customizations || { color: "#f0b429" },
        })
      );
    }
    renderBoard({
      board: Object.assign({}, req.board, { snakes }),
      you,
      youId: you && you.id,
    });
  }

  function apiBase() {
    const el = document.getElementById("fsApiUrl");
    return ((el && el.value) || API_DEFAULT).replace(/\/$/, "");
  }

  function setApiPill(msg, ok) {
    const el = document.getElementById("fsApiPill");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("ok", !!ok);
    el.classList.toggle("bad", ok === false);
  }

  async function apiFetch(path, opts) {
    const res = await fetch(apiBase() + path, opts);
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    return res.json();
  }

  function stopApiPoll() {
    // Bump token so the theaterLoop exits; clear any legacy interval
    runToken++;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function freezeBrain() {
    if (!live || !live.hooks) return;
    setStick("up", false);
    pushBrain(
      live.hooks,
      { courtship: 0, safety: 0, hunger: 0, neuron_targets: { ALPN: 0.05, DAN: 0.05, MBON: 0.05, KC_escape: 0 } },
      0.02,
      null
    );
  }

  async function applyApiFrame(frame, animate, pending) {
    if (!frame || !frame.decision) return;
    // Only drive fly / brain / joystick while a game is actively moving
    if (frame.phase && frame.phase !== "move" && frame.phase !== "playing" && frame.phase !== "start") {
      return;
    }
    const turn = frame.turn;
    const gid = frame.game_id || null;
    if (gid && gid !== lastHandledGameId) {
      lastHandledGameId = gid;
      lastSeenTurn = null;
    }
    if (turn != null && turn === lastSeenTurn && !animate) return;
    const isNew = turn !== lastSeenTurn;
    lastSeenTurn = turn;

    const move = frame.decision.move;
    const signals = frame.decision.signals || {};
    const scored = frame.decision.scored || [];
    live.lastMove = move;
    live.lastSignals = signals;
    live.mode = "api";

    // Board first — every queued turn must paint
    if (frame.request) renderFromApiRequest(frame.request);

    const readout = document.getElementById("fsMoveReadout");
    if (readout) {
      readout.textContent =
        `move: ${move}` +
        (frame.decision.shout ? ` · “${frame.decision.shout}”` : "") +
        (turn != null ? ` · t${turn}` : "") +
        (pending > 0 ? ` · queue ${pending}` : "");
    }
    renderMeters(signals);
    renderScores(scored);
    const visual = frame.request ? boardToVisual(frame.request, move) : null;
    if (live.hooks) {
      pushBrain(live.hooks, signals, Math.min(0.95, 0.2 + (turn || 0) * 0.01), visual);
      pushEyes(live.hooks, frame.request, move);
    }

    if (isNew || animate) {
      // Keep stick snappy when catching up so we don't fall further behind
      await animateJoystick(move, pending > 8 ? 45 : pending > 3 ? 90 : 180);
      const you = frame.request && frame.request.you;
      logTurn(
        `api t${turn} → ${move} · court ${((signals.courtship || 0) * 100) | 0}%` +
          (you ? ` · hp ${you.health} · len ${you.length}` : ""),
        "pass"
      );
    }
  }

  function clearOutcomeLabel() {
    const pill = document.getElementById("fsOutcomePill");
    const wrap = document.querySelector(".fs-board-wrap");
    if (pill) {
      pill.hidden = true;
      pill.textContent = "";
      pill.classList.remove("win", "lose");
    }
    if (wrap) wrap.classList.remove("is-final");
  }

  function showOutcomeLabel(outcome) {
    const pill = document.getElementById("fsOutcomePill");
    const wrap = document.querySelector(".fs-board-wrap");
    if (!pill) return;
    const win = outcome === "win";
    const lose = outcome === "eliminated" || outcome === "lose";
    pill.hidden = false;
    pill.classList.toggle("win", win);
    pill.classList.toggle("lose", lose || (!win && outcome !== "survived"));
    if (win) pill.textContent = "WIN";
    else if (outcome === "survived") pill.textContent = "SURVIVED";
    else pill.textContent = "LOSE";
    if (wrap) wrap.classList.add("is-final");
  }

  function outcomeFromEndFrame(frame) {
    const a = frame.analysis || {};
    if (a.outcome) return a.outcome;
    const req = frame.request || {};
    const you = req.you || {};
    const snakes = ((req.board || {}).snakes || []).filter((s) => s && s.id);
    const youAlive = snakes.some((s) => s.id === you.id);
    if (youAlive && snakes.length === 1) return "win";
    if (youAlive) return "survived";
    return "eliminated";
  }

  async function handleEndFrame(frame) {
    const gid = frame.game_id || frame.logged_game_id || "end";
    if (gid === lastEndedGameId) return;
    lastEndedGameId = gid;

    // Hold the final board + win/lose badge before chaining
    if (frame.request) renderFromApiRequest(frame.request);
    const outcome = outcomeFromEndFrame(frame);
    showOutcomeLabel(outcome);
    freezeBrain();

    const label = outcome === "win" ? "WIN" : outcome === "survived" ? "SURVIVED" : "LOSE";
    const readout = document.getElementById("fsMoveReadout");
    if (readout) {
      const turn = frame.turn != null ? ` · t${frame.turn}` : "";
      readout.textContent = `${label}${turn} · final board`;
    }

    if (chainActive) chainPlayed += 1;
    const progress = chainActive ? ` · ${chainPlayed}/${chainTarget}` : "";
    setStatus(`${label.toLowerCase()}${progress}`);
    logTurn(
      `${label} · ` + String(gid).slice(0, 8) + progress,
      outcome === "win" ? "pass" : "fail"
    );

    // Let the final frame sit so you can actually see it
    await sleep(outcome === "win" ? 1400 : 1100);

    if (chainActive && chainPlayed >= chainTarget) {
      chainActive = false;
      setStatus(`batch done · ${chainPlayed}/${chainTarget} · evaluating`);
      logTurn(`batch complete · ${chainPlayed} games — evaluating`, "pass");
      try {
        await reviewBatch(chainPlayed);
      } catch (_) {
        try {
          await reviewLastGame();
        } catch (__) {}
      }
    } else if (chainActive) {
      setStatus(`starting ${chainPlayed + 1}/${chainTarget}…`);
      window.setTimeout(() => {
        startRealGame(Object.assign({}, playOpts, { continueChain: true })).catch(() => {});
      }, 200);
    } else if (frame.analysis || frame.logged_game_id) {
      try {
        await reviewLastGame();
      } catch (_) {}
    }
  }

  function startApiPoll() {
    stopApiPoll();
    live.mode = "api";
    live.playing = false;
    pollBusy = false;
    const token = runToken; // stopApiPoll already bumped; capture for this loop
    setStatus(chainActive ? `listening · batch ${chainTarget}` : "listening api");

    // Single async loop (not setInterval) so we never skip queued turns while animating
    (async function theaterLoop() {
      while (live && token === runToken) {
        if (pollBusy) {
          await sleep(20);
          continue;
        }
        pollBusy = true;
        try {
          // Pull a small batch; animate each frame in order
          const pack = await apiFetch("/dev/frames?n=6");
          const frames = pack.frames || [];
          let pending = pack.pending || 0;
          if (!frames.length) {
            const st = await apiFetch("/dev/status");
            setApiPill(
              "api · " +
                ((st.last && st.last.phase) || "idle") +
                (st.play_running ? " · playing" : "") +
                (st.frames_pending ? ` · q${st.frames_pending}` : ""),
              true
            );
          }
          for (let i = 0; i < frames.length; i++) {
            if (token !== runToken) break;
            const frame = frames[i];
            const behind = pending + (frames.length - 1 - i);
            setApiPill(
              `api · ${frame.phase || "?"}` +
                (frame.turn != null ? ` · t${frame.turn}` : "") +
                (behind > 0 ? ` · q${behind}` : ""),
              true
            );
            if (frame.phase === "start") {
              lastSeenTurn = null;
              lastHandledGameId = frame.game_id || null;
              clearOutcomeLabel();
              if (frame.request) renderFromApiRequest(frame.request);
              setStatus(
                chainActive
                  ? `game start · ${Math.min(chainPlayed + 1, chainTarget)}/${chainTarget}`
                  : "game start"
              );
            } else if (frame.phase === "move" || frame.phase === "playing") {
              await applyApiFrame(frame, true, behind);
              setStatus(
                chainActive
                  ? `live · ${Math.min(chainPlayed + 1, chainTarget)}/${chainTarget}` +
                      (behind ? ` · catch-up ${behind}` : "")
                  : behind
                    ? `live · catch-up ${behind}`
                    : "live api"
              );
            } else if (frame.phase === "end") {
              await handleEndFrame(frame);
            }
          }
        } catch (err) {
          setApiPill("api offline", false);
        } finally {
          pollBusy = false;
        }
        // Faster when catching up; idle poll stays light
        await sleep(16);
      }
    })();
  }

  async function startRealGame(opts) {
    opts = opts || {};
    playOpts = { multi: !!opts.multi };
    const continuing = !!opts.continueChain;
    if (!continuing) {
      chainPlayed = 0;
      chainTarget = opts.batchSize || CHAIN_TARGET_DEFAULT;
      lastEndedGameId = null;
    }
    chainActive = true;
    clearOutcomeLabel();
    showLocalBoard();
    startApiPoll();
    setStatus(`starting ${Math.min(chainPlayed + 1, chainTarget)}/${chainTarget}…`);
    try {
      const status = await apiFetch("/dev/status");
      setApiPill("api · online", true);
      if (!status.battlesnake_cli) {
        setStatus("need battlesnake CLI");
        logTurn("install: go install github.com/BattlesnakeOfficial/rules/cli/battlesnake@latest", "fail");
        return;
      }
      if (status.play_running) {
        setStatus("game already running");
        return;
      }
      const body = {
        name: "Walton-LoFly-v0.1",
        gametype: opts.multi ? "standard" : "solo",
        width: 11,
        height: 11,
        // Engine pace for theater — console drains /dev/frames so every turn still paints
        delay: 160,
      };
      if (opts.multi) {
        body.opponents = [
          { name: "Rival-Cyan", url: "http://127.0.0.1:8002" },
          { name: "Rival-Coral", url: "http://127.0.0.1:8003" },
        ];
      }
      const result = await apiFetch("/dev/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!result.ok) {
        setStatus("start failed");
        logTurn(result.error || "play failed", "fail");
        return;
      }
      lastSeenTurn = null;
      lastHandledGameId = null;
      const nOpp = (result.opponents && result.opponents.length) || 0;
      logTurn(
        (nOpp ? "multi · " : "solo · ") +
          `${chainPlayed + 1}/${chainTarget} · ` +
          (result.cmd || []).join(" ")
      );
      setStatus(`${nOpp ? "vs rivals" : "solo"} · ${chainPlayed + 1}/${chainTarget}`);
      if (live.hooks && live.hooks.noteEl) {
        live.hooks.noteEl.textContent =
          `Batch ${chainTarget} games then evaluate. Progress ${chainPlayed}/${chainTarget}. Pause stops the chain.`;
      }
    } catch (err) {
      setApiPill("api offline", false);
      setStatus("start server first");
      logTurn("start server: bash activities/fs-avatar/ensure_up.sh  (detached :8001)", "fail");
    }
  }

  function showPublicUrl(url) {
    const el = document.getElementById("fsPublicUrl");
    if (!el) return;
    if (!url) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML =
      '<span class="fs-public-k">public snake URL</span>' +
      '<a class="fs-public-url" href="' +
      url +
      '" target="_blank" rel="noopener">' +
      url +
      "</a>" +
      '<span class="fs-public-hint">paste into battlesnake.com</span>';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async function reviewLastGame() {
    const body = document.getElementById("fsReviewBody");
    if (body) body.textContent = "loading last game…";
    try {
      const data = await apiFetch("/dev/game/latest?summary=1");
      const a = data.analysis || {};
      const maps = a.neuron_mappings || [];
      const next = a.creative_next_steps || [];
      const lines = [];
      lines.push(
        `<div class="fs-review-head"><strong>${escapeHtml(data.outcome || "?")}</strong> · ${
          data.n_turns || 0
        } turns · len ${escapeHtml(String((data.final || {}).you_length || "?"))} · id ${escapeHtml(
          (data.game_id || "").slice(0, 8)
        )}</div>`
      );
      lines.push(
        `<div class="fs-review-stats">court ${a.avg_courtship} · cone ${a.avg_cone_ratio != null ? a.avg_cone_ratio : a.avg_safety} · size ${a.avg_size_advantage != null ? a.avg_size_advantage : "?"} · hunger ${a.avg_hunger} · near-miss ${a.near_miss_turns} · panic ${a.panic_turns} · food≈${a.food_eaten_est} (risky ${a.risky_food_frames}) · len ${a.length_peak} vs rival ${a.rival_length_peak != null ? a.rival_length_peak : "?"}</div>`
      );
      lines.push('<div class="cap" style="margin-top:8px">wire these next</div>');
      maps.slice(0, 6).forEach((m) => {
        lines.push(
          `<div class="fs-map-card"><div class="fs-map-title">${escapeHtml(m.neuron)} <span class="fs-map-w">w ${m.weight_hint}</span></div>` +
            `<div class="fs-map-sig">${escapeHtml(m.signal)} · ${escapeHtml(m.stat)}</div>` +
            `<div class="fs-map-idea">${escapeHtml(m.idea)}</div></div>`
        );
      });
      if (next.length) {
        lines.push('<div class="cap" style="margin-top:8px">creative next</div><ul class="fs-review-next">');
        next.forEach((n) => {
          lines.push(`<li>${escapeHtml(n)}</li>`);
        });
        lines.push("</ul>");
      }
      if (body) body.innerHTML = lines.join("");
      setStatus("reviewed " + (data.outcome || "game"));
    } catch (err) {
      if (body) {
        body.textContent =
          "No logged game yet (or API offline). Finish a Solo / Vs rivals match first — logs write on /end.";
      }
    }
  }

  async function reviewBatch(limit) {
    const n = limit || chainTarget || CHAIN_TARGET_DEFAULT;
    const body = document.getElementById("fsReviewBody");
    if (body) body.textContent = `loading batch of ${n}…`;
    try {
      const b = await apiFetch("/dev/batch?limit=" + encodeURIComponent(n));
      if (!b.ok) {
        if (body) body.textContent = b.note || "no batch data";
        return;
      }
      const lines = [];
      const wr = ((b.win_rate || 0) * 100).toFixed(0);
      lines.push(
        `<div class="fs-review-head"><strong>batch ${b.n}</strong> · ${b.wins}W / ${b.eliminated}L` +
          (b.survived ? ` / ${b.survived} survived` : "") +
          ` · win ${wr}% · wiring ${escapeHtml(b.wiring || "?")}` +
          ` · next→${b.next_batch_size || 20}</div>`
      );
      lines.push(
        `<div class="fs-review-stats">avg turns ${b.avg_turns} · food≈${b.avg_food_eaten} (Σ${b.food_total}) · cone ${b.avg_cone_ratio} · size ${b.avg_size_advantage} · len ${b.avg_length_peak} vs rival ${b.avg_rival_peak} · panic ${b.avg_panic_turns}</div>`
      );
      lines.push(`<div class="fs-map-idea" style="margin:6px 0">${escapeHtml(b.verdict || "")}</div>`);
      if (b.outcomes && b.outcomes.length) {
        lines.push(
          `<div class="fs-review-stats">outcomes: ${b.outcomes
            .map((o) => (o === "win" ? "W" : o === "eliminated" ? "L" : "?"))
            .join(" ")}</div>`
        );
      }
      lines.push('<div class="cap" style="margin-top:8px">batch neuron priorities</div>');
      (b.neuron_mappings || []).slice(0, 6).forEach((m) => {
        lines.push(
          `<div class="fs-map-card"><div class="fs-map-title">${escapeHtml(m.neuron || "")} <span class="fs-map-w">w ${m.weight_hint}</span></div>` +
            `<div class="fs-map-sig">${escapeHtml(m.signal)} · across ${m.games} games</div>` +
            `<div class="fs-map-idea">${escapeHtml(m.idea || "")}</div></div>`
        );
      });
      if (body) body.innerHTML = lines.join("");
      setStatus(`batch ${b.n} · win ${wr}% · next ${b.next_batch_size}`);
      logTurn(`batch eval · ${b.n} games · win ${wr}% · ${b.verdict || ""}`, "pass");
    } catch (err) {
      if (body) body.textContent = "Batch review failed — is the API up? GET /dev/batch?limit=" + n;
    }
  }

  function setStick(move, pressing) {
    const stick = document.getElementById("fsStick");
    const fly = document.getElementById("fsFly");
    const well = document.getElementById("fsStickWell");
    if (!stick || !well) return;

    const map = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };
    const d = map[move] || { x: 0, y: 0 };
    stickPose = d;
    const throwPx = 28;
    stick.style.transform = `translate(${d.x * throwPx}px, ${d.y * throwPx}px)`;
    stick.classList.toggle("pressing", !!pressing);

    document.querySelectorAll(".fs-dir").forEach((el) => {
      el.classList.toggle("active", el.classList.contains(move));
    });

    if (fly) {
      const baseX = well.clientWidth / 2 - FLY_SIZE / 2 + d.x * 36;
      const baseY = well.clientHeight / 2 - FLY_SIZE / 2 - 36 + d.y * 28;
      fly.style.transform = `translate(${baseX}px, ${baseY}px) rotate(${
        d.x * 25 + (d.y > 0 ? 10 : d.y < 0 ? -10 : 0)
      }deg)`;
      fly.classList.add("visible");
      fly.classList.toggle("pushing", !!pressing);
    }
  }

  async function animateJoystick(move, totalMs) {
    const total = totalMs != null ? totalMs : 420;
    const press = Math.max(30, Math.floor(total * 0.5));
    const pre = Math.max(16, Math.floor(total * 0.25));
    const post = Math.max(16, total - press - pre);
    setStick(move, false);
    await sleep(pre);
    setStick(move, true);
    await sleep(press);
    setStick(move, false);
    await sleep(post);
  }

  function renderMeters(signals) {
    const el = document.getElementById("fsMeters");
    if (!el || !signals) return;
    const rows = [
      ["courtship", signals.courtship],
      ["eye open", signals.retina_open != null ? signals.retina_open : 0],
      ["eye fruit", signals.retina_fruit != null ? signals.retina_fruit : 0],
      ["eye threat", signals.retina_threat != null ? signals.retina_threat : 0],
      ["sector entropy", signals.sector_entropy != null ? signals.sector_entropy : signals.region_entropy || 0],
      ["safety (cone)", signals.safety],
      ["size vs rivals", signals.size_advantage != null ? signals.size_advantage : 0.5],
      ["race mode", signals.food_race ? 1 : 0],
      ["DAN reward", signals.neuron_targets && signals.neuron_targets.DAN != null
        ? Math.min(1, signals.neuron_targets.DAN)
        : 0],
    ];
    el.innerHTML = rows
      .map(([label, v]) => {
        const pct = Math.round(Math.max(0, Math.min(1, v || 0)) * 100);
        return `<div class="fs-meter"><span class="fs-meter-l">${label}</span><div class="fs-meter-bar"><i style="width:${pct}%"></i></div><span class="fs-meter-v mono">${pct}%</span></div>`;
      })
      .join("");
  }

  function renderScores(scored) {
    const el = document.getElementById("fsScores");
    if (!el) return;
    el.innerHTML = (scored || [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((s) => {
        const bad = s.fatal ? " fatal" : "";
        const top = !s.fatal && s.legal && s.move === (live && live.lastMove) ? " top" : "";
        return `<div class="fs-score-row${bad}${top}"><span>${s.move}</span><span>${
          s.fatal ? s.reason || "fatal" : s.score.toFixed(2)
        }</span><span>space ${s.space || 0}${s.coneEmpty != null ? ` · cone ${s.coneEmpty}` : ""}${
          s.retinaOpen != null ? ` · eye ${s.retinaOpen.toFixed(2)}` : ""
        }</span></div>`;
      })
      .join("");
  }

  async function playTurn(token) {
    if (!live || !live.state || live.state.over) return;
    const req = global.FsAvatarGame.toMoveRequest(live.state);
    const decision = global.FsAvatarPolicy.decide(req);
    live.lastMove = decision.move;
    live.lastSignals = decision.signals;

    const readout = document.getElementById("fsMoveReadout");
    if (readout) readout.textContent = `move: ${decision.move}` + (decision.shout ? ` · “${decision.shout}”` : "");

    renderMeters(decision.signals);
    renderScores(decision.scored);
    const visual = boardToVisual(req, decision.move);
    pushBrain(
      live.hooks,
      decision.signals,
      Math.min(0.95, 0.15 + live.state.turn * 0.01),
      visual
    );
    pushEyes(live.hooks, req, decision.move);

    await animateJoystick(decision.move);
    if (token !== runToken) return;

    global.FsAvatarGame.step(live.state, decision.move);
    renderBoard(live.state);

    const you = live.state.you;
    logTurn(
      `t${live.state.turn} → ${decision.move} · court ${(decision.signals.courtship * 100) | 0}% · hp ${you.health} · len ${you.length}`,
      you.eliminated ? "fail" : ""
    );

    if (live.state.over) {
      const win = live.state.winnerId === live.state.youId;
      setStatus(win ? "YOU win" : you.eliminated ? "eliminated" : "game over");
      logTurn(win ? "Walton-LoFly-v0.1 survives" : `out · ${you.eliminationCause || "loss"}`, win ? "pass" : "fail");
      live.playing = false;
      if (live.hooks.noteEl) {
        live.hooks.noteEl.textContent = win
          ? "FS-Avatar survived — courtship held in open space. Ready to wire these signals to MaleCNS groups."
          : "FS-Avatar eliminated — inspect danger/space scores, then retune policy / neuron map.";
      }
      if (live.hooks.tabsEl) {
        live.hooks.tabsEl.innerHTML = `<button class="tab active" type="button">fs-avatar · ${
          win ? "win" : "loss"
        }</button>`;
      }
    }
  }

  async function playLoop() {
    const token = ++runToken;
    live.playing = true;
    setStatus("playing");
    while (live && live.playing && live.state && !live.state.over && token === runToken) {
      await playTurn(token);
      if (!live.playing || live.state.over) break;
      await sleep(live.turnMs || 480);
    }
  }

  function resetGame() {
    runToken++;
    live.playing = false;
    live.mode = "sim";
    live.state = global.FsAvatarGame.createGame({
      youName: "Walton-LoFly-v0.1",
      youColor: "#f0b429",
      nOpponents: 2,
      food: 3,
    });
    live.lastMove = null;
    lastSeenTurn = null;
    renderBoard(live.state);
    setStick("up", false);
    setStatus("ready");
    const log = document.getElementById("fsLog");
    if (log) log.innerHTML = "";
    logTurn("local sim · you are Walton-LoFly-v0.1 (gold) · greedy hunger");
    pushBrain(live.hooks, { courtship: 0.5, safety: 0.5, hunger: 0.95, neuron_targets: {} }, 0.05);
  }

  function showLocalBoard() {
    const host = document.getElementById("fsIframeHost");
    const board = boardSvg();
    if (host) host.hidden = true;
    if (board) board.hidden = false;
  }

  function watchGame(raw) {
    let id = (raw || "").trim();
    const m = id.match(/game\/([0-9a-f-]{36})/i) || id.match(/([0-9a-f-]{36})/i);
    if (m) id = m[1];
    if (!id) {
      setStatus("need game id");
      return;
    }
    const host = document.getElementById("fsIframeHost");
    const board = boardSvg();
    const iframe = document.getElementById("fsIframe");
    if (board) board.hidden = true;
    if (host) host.hidden = false;
    if (iframe) {
      iframe.src =
        "https://board.battlesnake.com/?engine=" +
        encodeURIComponent("https://engine.battlesnake.com") +
        "&game=" +
        encodeURIComponent(id);
    }
    setStatus("watching " + id.slice(0, 8) + "…");
    logTurn("iframe watch · " + id + " (view only)");
  }

  async function startLive(hooks) {
    await loadScript(FS_BASE + "policy.js");
    await loadScript(FS_BASE + "game.js");

    ensureChrome(hooks.slot);
    live = { hooks, playing: false, turnMs: 480, state: null, mode: "sim" };

    hooks.meta = Object.assign({}, hooks.meta || {}, {
      t_run_ms: 150,
      stages: ["ALPN", "Kenyon_Cell", "MBON", "DAN"],
      stage_labels: {
        ALPN: "ALPN (threat)",
        Kenyon_Cell: "Kenyon cell",
        MBON: "MBON (space)",
        DAN: "DAN (food/court)",
      },
    });

    if (hooks.tabsEl) {
      hooks.tabsEl.innerHTML =
        '<button class="tab active" type="button">fs-avatar · Walton-LoFly-v0.1</button>';
    }
    if (hooks.dotsEl) hooks.dotsEl.innerHTML = "";
    if (hooks.labelEl) hooks.labelEl.textContent = "live API · joystick theater";
    if (hooks.prevBtn) hooks.prevBtn.disabled = true;
    if (hooks.nextBtn) hooks.nextBtn.disabled = true;
    if (hooks.noteEl) {
      hooks.noteEl.textContent =
        "FS-Avatar — real Battlesnake /move webhook. Start real game uses the CLI against your local server; joystick mirrors each decision.";
    }

    document.getElementById("fsStartApi").onclick = () => startRealGame({ multi: false });
    const multiBtn = document.getElementById("fsStartMulti");
    if (multiBtn) multiBtn.onclick = () => startRealGame({ multi: true });
    const reviewBtn = document.getElementById("fsReview");
    if (reviewBtn) reviewBtn.onclick = () => reviewLastGame();
    const batchBtn = document.getElementById("fsReviewBatch");
    if (batchBtn) batchBtn.onclick = () => reviewBatch(chainTarget || CHAIN_TARGET_DEFAULT);
    showPublicUrl("https://donna-mesh-quebec-bronze.trycloudflare.com");
    document.getElementById("fsPlay").onclick = () => {
      chainActive = false;
      stopApiPoll();
      if (!live.state || live.state.over || live.mode === "api") resetGame();
      showLocalBoard();
      if (!live.playing) playLoop();
    };
    document.getElementById("fsPause").onclick = () => {
      live.playing = false;
      chainActive = false;
      runToken++;
      stopApiPoll();
      freezeBrain();
      setStatus("paused · auto-chain off");
    };
    document.getElementById("fsReset").onclick = () => {
      chainActive = false;
      stopApiPoll();
      showLocalBoard();
      resetGame();
    };
    document.getElementById("fsWatch").onclick = () => {
      watchGame(document.getElementById("fsGameId").value);
    };
    document.getElementById("fsLocal").onclick = () => {
      showLocalBoard();
      setStatus(live.playing ? "playing" : live.mode === "api" ? "listening api" : "ready");
    };

    resetGame();
    // Probe API; if online, listen (don't auto-start a game until user clicks).
    try {
      const st = await apiFetch("/dev/status");
      setApiPill("api · online" + (st.battlesnake_cli ? " · cli" : " · no cli"), true);
      startApiPoll();
    } catch (err) {
      setApiPill("api offline · bash activities/fs-avatar/ensure_up.sh", false);
    }
  }

  function aboutHtml() {
    return `
      <div><strong style="color:var(--text)">Real API:</strong> <code>server.py</code> is a full Battlesnake webhook (<code>/</code>, <code>/start</code>, <code>/move</code>, <code>/end</code>). Console mirrors live <code>/move</code> via <code>GET /dev/last</code>.</div>
      <div><strong style="color:var(--text)">Start a game:</strong> run the server, install the CLI, then click <em>Start real game</em> (or <code>./play.sh</code>). Engine calls your snake; fly shoves the stick.</div>
      <div><strong style="color:var(--text)">YOU:</strong> gold / registered name <em>Walton-LoFly-v0.1</em> (last name required for Funathon).</div>
      <div><strong style="color:var(--text)">Policy:</strong> danger → retina sectors (open/fruit/threat) → forward-cone → flood-fill → food. Bigger snakes race fruit; hex eyes paint the same channels.</div>
      <div><strong style="color:var(--text)">Next:</strong> wire <code>size_advantage</code> → DAN_risk and <code>cone_ratio</code> → MBON from review logs.</div>`;
  }

  global.FlyActivity = { startLive, aboutHtml };
})(window);
