/**
 * LoFly — hears one song, sees the crate, courts by multi-factor pheromone.
 */
(function (global) {
  "use strict";

  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function ensureSlot(slot) {
    if (slot.dataset.loflyReady === "1") return;
    slot.innerHTML = `
      <div class="lofly-chrome">
        <span class="cap">hearing · now playing</span>
        <div id="loflyPlaying" class="lofly-mix mono"></div>
        <span class="cap">courting · pheromone partner</span>
        <div id="loflyCourting" class="lofly-mix mono"></div>
        <span class="cap">chroma · what it's hearing</span>
        <div class="chroma-grid" id="loflyChroma"></div>
        <span class="cap">match pheromone</span>
        <div class="stim-track lofly-court-track">
          <div class="stim-fill" id="loflyCourtFill"></div>
        </div>
        <div class="mono lofly-court-label" id="loflyCourtLabel"></div>
        <span class="cap">top pheromone trails</span>
        <div id="loflyAlts" class="lofly-alts mono"></div>
        <span class="cap">courtship ticks</span>
        <div id="loflyTicks" class="lofly-alts mono"></div>
      </div>`;
    slot.dataset.loflyReady = "1";
    delete slot.dataset.tttReady;
    delete slot.dataset.percReady;
  }

  function kindClass(kind) {
    if (!kind) return "";
    if (kind === "clash" || kind === "two_apart" || kind === "unknown") return "bad";
    if (kind === "diagonal") return "mid";
    return "good";
  }

  function mount(ctx) {
    const { slot, noteEl, episode, step, stateData } = ctx;
    ensureSlot(slot);
    const p = stateData.activity_payload || {};
    const stim = stateData.stimulus || { channels: [], values: [] };
    const kind = p.camelot_kind || "";
    const ph = Number(p.pheromone != null ? p.pheromone : p.courtship_drive || 0);

    document.getElementById("loflyPlaying").innerHTML = `
      <div class="lofly-row">
        <span class="lofly-title">${escapeHtml(p.playing_title || p.from_title || "?")}</span>
        <span class="lofly-badge">${escapeHtml(p.playing_camelot || p.from_camelot || "")}</span>
        <span class="lofly-bpm">${fmtBpm(p.playing_bpm || p.from_bpm)}</span>
      </div>
      <div class="lofly-bpm">${p.playing_duration_s != null ? Number(p.playing_duration_s).toFixed(0) + "s song clock" : ""}</div>`;

    document.getElementById("loflyCourting").innerHTML = `
      <div class="lofly-row">
        <span class="lofly-title">${escapeHtml(p.courting_title || p.to_title || "?")}</span>
        <span class="lofly-badge">${escapeHtml(p.courting_camelot || p.to_camelot || "")}</span>
        <span class="lofly-bpm">${fmtBpm(p.courting_bpm || p.to_bpm)}</span>
      </div>
      <div class="lofly-arrow ${kindClass(kind)}">${escapeHtml(kind || "camelot")} · ph ${ph.toFixed(2)}</div>`;

    const maxC = Math.max(0.01, ...stim.values.map(Number));
    document.getElementById("loflyChroma").innerHTML = stim.channels
      .map((ch, i) => {
        const v = Number(stim.values[i] || 0);
        const t = v / maxC;
        const bg = `color-mix(in srgb, ${tok("--violet")} ${Math.round(18 + t * 72)}%, var(--panel))`;
        return `<div class="chroma-cell" style="background:${bg}" title="${ch}: ${v.toFixed(3)}">
          <span class="chroma-note">${ch}</span>
        </div>`;
      })
      .join("");

    const fill = document.getElementById("loflyCourtFill");
    fill.style.width = `${Math.round(ph * 100)}%`;
    fill.style.background = ph >= 0.85 ? tok("--green") : ph >= 0.5 ? tok("--amber") : tok("--coral");
    document.getElementById("loflyCourtLabel").textContent =
      `${(ph * 100).toFixed(0)}% match pheromone · ${p.n_switches || 0} partner switches / ${p.n_ticks || "?"} ticks`;

    const alts = p.top_alternatives || [];
    document.getElementById("loflyAlts").innerHTML = alts.length
      ? alts
          .map((a, i) => {
            const k = a.kind || "";
            const pv = a.pheromone != null ? a.pheromone : a.score;
            return `<div class="lofly-alt">
              <span class="lofly-alt-i">${i + 1}.</span>
              <span class="lofly-badge sm">${escapeHtml(a.camelot || "")}</span>
              <span class="${kindClass(k)}">${escapeHtml(k)}</span>
              <span class="lofly-alt-title">${escapeHtml(a.title)}</span>
              <span class="lofly-alt-score">ph ${Number(pv).toFixed(2)}</span>
            </div>`;
          })
          .join("")
      : "—";

    const hist = p.courtship_history || [];
    const tickEl = document.getElementById("loflyTicks");
    if (!hist.length) {
      tickEl.textContent = "—";
    } else {
      tickEl.innerHTML = hist
        .filter((h) => h.switched || h.tick === 0 || h.tick === hist.length - 1)
        .map((h) => {
          const tag = h.switched ? "switch" : h.tick === 0 ? "start" : "end";
          return `<div class="lofly-alt">
            <span class="lofly-alt-i">${tag}</span>
            <span class="lofly-bpm">t=${Number(h.t_song_s).toFixed(0)}s</span>
            <span class="lofly-alt-title">${escapeHtml(h.courting_title || "")}</span>
            <span class="lofly-alt-score">ph ${Number(h.courting_pheromone).toFixed(2)}</span>
          </div>`;
        })
        .join("");
    }

    if (noteEl) {
      const n = episode.step_state_ids.length;
      const locked = p.found_best || p.challenge_win;
      noteEl.innerHTML = `Song ${step + 1} / ${n} · heard <span class="mono">${escapeHtml(p.playing_camelot || "")}</span>,
        courted <span class="mono">${escapeHtml(p.courting_camelot || "")}</span>
        <span class="outcome-pill ${locked ? "win" : "loss"}">${locked ? "BEST LOCK" : "NEAR"}</span>`;
    }
  }

  function fmtBpm(v) {
    return v != null ? Number(v).toFixed(0) + " bpm" : "";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function episodeTabLabel(ep) {
    return ep.note || "LoFly courtship";
  }

  function aboutHtml(meta) {
    const ap = meta.activity_payload || {};
    const n = ap.catalogue_n || "?";
    const t = ap.toggles || {};
    const on = (k) => (t[k] ? "on" : "off");
    return `
      <div><strong style="color:var(--text)">Hearing:</strong> one song’s chroma stream (the playing partner).</div>
      <div><strong style="color:var(--text)">Seeing:</strong> the full crate (${n} tracks). Pheromone = Camelot (0.42) + tempo (0.25) + chroma courtship drive (0.20) + novelty (0.13).</div>
      <div><strong style="color:var(--text)">Toggles:</strong> clash penalty ${on("clash_penalty")} · novelty ${t.novelty === false ? "off" : "on"} · Camelot boost ${on("camelot_boost")} <span class="mono">(${escapeHtml(ap.toggles_label || "—")})</span></div>
      <div><strong style="color:var(--text)">Courting:</strong> starts random, then follows the strongest trail before the song clock runs out.</div>`;
  }

  global.FlyActivity = { mount, episodeTabLabel, aboutHtml };
})(window);
