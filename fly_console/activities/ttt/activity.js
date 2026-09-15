/**
 * Tic-tac-toe activity chrome: input/output boards, move rings, step notes.
 * Registers window.FlyActivity for the console shell.
 */
(function (global) {
  "use strict";

  const T = () => global.FlyExperience && global.FlyExperience.T;

  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function argmaxLegal(board, scores) {
    let best = -Infinity;
    let idx = -1;
    for (let i = 0; i < 9; i++) {
      if (board[i] !== 0) continue;
      if (scores[i] > best) {
        best = scores[i];
        idx = i;
      }
    }
    return idx;
  }

  function renderBoardGrid(container, board, opts) {
    const mode = opts.mode || "input";
    const rates = opts.rates || [];
    const maxRate = opts.maxRate || 220;
    const hotColor = opts.hotColor || tok("--gold");
    const pickIdx = opts.pickIdx;
    const bestIdx = opts.bestIdx;
    const showRateText = !!opts.showRateText;

    container.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const v = board[i];
      if (v === 1) {
        cell.classList.add("x");
        cell.textContent = "X";
      } else if (v === 2) {
        cell.classList.add("o");
        cell.textContent = "O";
      } else {
        cell.textContent = "";
      }

      const r = rates[i] || 0;
      const t = Math.max(0, Math.min(1, r / maxRate));
      if (mode === "input" && r > 0) {
        cell.style.background = `color-mix(in srgb, ${hotColor} ${Math.round(t * 55)}%, var(--panel))`;
      }
      if (mode === "output") {
        cell.style.background = `color-mix(in srgb, ${hotColor} ${Math.round(t * 70)}%, var(--panel))`;
      }

      if (pickIdx === i) {
        cell.style.outline = `2px solid ${tok("--gold")}`;
        cell.style.outlineOffset = "-2px";
      }
      if (bestIdx === i && bestIdx !== pickIdx) {
        cell.style.boxShadow = `inset 0 0 0 2px ${tok("--cyan")}`;
      }

      if (showRateText && mode === "output") {
        const span = document.createElement("span");
        span.className = "rate";
        span.textContent = Math.round(r);
        cell.appendChild(span);
      }
      container.appendChild(cell);
    }
  }

  function ensureSlot(slot) {
    if (slot.dataset.tttReady === "1") return;
    slot.innerHTML = `
      <div class="board-area">
        <div class="board-col">
          <span class="cap">input · board</span>
          <div class="board" id="boardIn"></div>
        </div>
        <div class="board-col">
          <span class="cap">output · move preference</span>
          <div class="board" id="boardOut"></div>
        </div>
      </div>
      <div class="legend-mini">
        <span><span class="ring-sample"></span> move actually played</span>
        <span><span class="ring-sample best"></span> current policy's top pick</span>
      </div>`;
    slot.dataset.tttReady = "1";
  }

  function mount(ctx) {
    const { slot, noteEl, meta, episode, step, stateData } = ctx;
    ensureSlot(slot);

    const payload = stateData.activity_payload || {};
    const board = payload.board || [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const moveRates =
      payload.move_rates ||
      (stateData.readout && stateData.readout.values) ||
      [];
    const epPay = episode.activity_payload || {};
    const flyMoves = epPay.fly_moves || episode.actions || [];
    const oppMoves = epPay.opp_moves || [];
    const flyMoveThisStep = flyMoves[step];
    const bias = (meta.activity_payload && meta.activity_payload.bias) || [
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    const scores = moveRates.map((r, i) => r + (bias[i] || 0));
    const bestIdx = argmaxLegal(board, scores);
    const isLast = step === episode.step_state_ids.length - 1;

    renderBoardGrid(document.getElementById("boardIn"), board, {
      mode: "input",
      rates: board.map((v) => (v === 0 ? 0 : 220)),
      maxRate: 220,
      hotColor: tok("--gold"),
      pickIdx: flyMoveThisStep,
    });

    renderBoardGrid(document.getElementById("boardOut"), board, {
      mode: "output",
      rates: moveRates,
      maxRate: 100,
      hotColor: tok("--cyan"),
      pickIdx: flyMoveThisStep,
      bestIdx,
      showRateText: true,
    });

    if (noteEl) {
      if (isLast) {
        const finalB = (epPay.final_board || []).join("");
        const pill =
          episode.outcome === "win" || episode.outcome === "loss"
            ? `<span class="outcome-pill ${episode.outcome}">${
                episode.outcome === "win" ? "FLY WINS" : "FLY LOSES"
              }</span>`
            : "";
        noteEl.innerHTML = `Fly plays cell ${flyMoveThisStep} here. Final board: <span class="mono">${finalB}</span> &nbsp; ${pill}`;
      } else {
        const opp = oppMoves[step];
        noteEl.textContent =
          opp != null
            ? `Fly plays cell ${flyMoveThisStep}, then the opponent replies at cell ${opp}.`
            : `Fly plays cell ${flyMoveThisStep}.`;
      }
    }
  }

  function episodeTabLabel(ep) {
    const idx = (ep.activity_payload && ep.activity_payload.game_idx) || "?";
    if (ep.outcome === "win") return `Game #${idx} · fly won`;
    if (ep.outcome === "loss") return `Game #${idx} · fly lost`;
    return ep.note || ep.id;
  }

  function aboutHtml() {
    return `
      <div><strong style="color:var(--text)">What's real:</strong> neuron identities, synapse signs/weights, and the Brian2 LIF run over that wiring — nothing here is a lookup table.</div>
      <div><strong style="color:var(--text)">What's a stand-in:</strong> a board cell maps to one ORN glomerulus and a move maps to one descending neuron. The connectome weights are frozen — only a 9-value bias learns (reservoir style).</div>
      <div><strong style="color:var(--text)">Honest caveat:</strong> relative move preference is similar across boards; much of the win-rate gain comes from the learned bias. Bias is clipped at ±60 Hz.</div>`;
  }

  global.FlyActivity = { mount, episodeTabLabel, aboutHtml };
})(window);
