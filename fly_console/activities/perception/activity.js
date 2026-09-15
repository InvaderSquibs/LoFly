/**
 * Odor-perception activity chrome: stimulus channel bars + stage readout list.
 * Proves the console can swap activities without changing cascade/raster/learning.
 */
(function (global) {
  "use strict";

  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function ensureSlot(slot) {
    if (slot.dataset.percReady === "1") return;
    slot.innerHTML = `
      <div class="board-col" style="align-items:stretch;width:100%">
        <span class="cap">stimulus · ORN channels</span>
        <div class="stim-bars" id="stimBars"></div>
      </div>
      <div class="board-col" style="align-items:stretch;width:100%;margin-top:16px">
        <span class="cap">pathway readout · mean Hz</span>
        <div class="readout-list" id="readoutList"></div>
      </div>`;
    slot.dataset.percReady = "1";
    delete slot.dataset.tttReady;
  }

  function mount(ctx) {
    const { slot, noteEl, episode, stateData } = ctx;
    ensureSlot(slot);

    const stim = stateData.stimulus || { channels: [], values: [] };
    const maxStim = Math.max(1, ...stim.values.map(Number), 1);
    const bars = document.getElementById("stimBars");
    bars.innerHTML = stim.channels
      .map((ch, i) => {
        const v = Number(stim.values[i] || 0);
        const pct = Math.round((v / maxStim) * 100);
        return `<div class="stim-row">
          <div class="stim-lab">${ch} · ${v.toFixed(1)} Hz</div>
          <div class="stim-track"><div class="stim-fill" style="width:${pct}%;background:${tok("--gold")}"></div></div>
        </div>`;
      })
      .join("");

    const ro = stateData.readout || { labels: [], values: [] };
    const list = document.getElementById("readoutList");
    list.innerHTML = ro.labels
      .map((lab, i) => {
        const v = Number(ro.values[i] || 0);
        return `<div class="ro"><span class="n">${lab}</span><span class="v">${v.toFixed(1)} Hz</span></div>`;
      })
      .join("");

    if (noteEl) {
      const name =
        (stateData.activity_payload && stateData.activity_payload.pretty_name) ||
        episode.note ||
        episode.id;
      noteEl.textContent = `Condition: ${name}. Same ALPN→KC→MBON→DAN evaluation as tic-tac-toe — only the stimulus encoding changed.`;
    }
  }

  function episodeTabLabel(ep) {
    return ep.note || ep.id;
  }

  function aboutHtml() {
    return `
      <div><strong style="color:var(--text)">What's shared:</strong> the fly experience panels (cascade, raster, stage rates) use the same contract as the tic-tac-toe activity.</div>
      <div><strong style="color:var(--text)">What swapped:</strong> odor conditions replace the 3×3 board. Stimulus channels are ORN glomeruli; there is no move preference grid.</div>
      <div><strong style="color:var(--text)">Learning:</strong> this export has no bandit/self-play curve — the learning panel stays empty on purpose.</div>`;
  }

  global.FlyActivity = { mount, episodeTabLabel, aboutHtml };
})(window);
