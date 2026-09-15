/**
 * LoFly live mode — random song at start, court while it plays,
 * stream pathway activity from the song (not a frozen trial replay).
 */
(function (global) {
  "use strict";

  const LOFLY_BASE = "activities/lofly/";
  const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BIN_MS = 250; // append a brain sample every 250ms of song
  const MAX_BINS = 480; // ~2 min display window

  let live = null;

  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtBpm(v) {
    return v != null ? Number(v).toFixed(0) + " bpm" : "";
  }

  function resolveLibraryUrl(path) {
    if (!path) return null;
    const rel = String(path).replace(/^\.\//, "");
    if (/^https?:\/\//i.test(rel)) return rel;
    if (rel.startsWith("activities/lofly/")) return encodeURI(rel);
    if (rel.startsWith("library/")) return encodeURI(LOFLY_BASE + rel);
    return encodeURI(LOFLY_BASE + "library/" + rel.replace(/^library\//, ""));
  }

  function kindClass(kind) {
    if (!kind) return "";
    if (kind === "clash" || kind === "two_apart" || kind === "unknown") return "bad";
    if (kind === "diagonal") return "mid";
    return "good";
  }

  function rng() {
    return Math.random();
  }

  function emptyCurves() {
    return { ALPN: [], Kenyon_Cell: [], MBON: [], DAN: [] };
  }

  function emptyRaster() {
    return { ALPN: [], Kenyon_Cell: [], MBON: [], DAN: [] };
  }

  function ensureRasterRows(raster, stage, n) {
    if (!raster[stage]) raster[stage] = [];
    while (raster[stage].length < n) {
      raster[stage].push({ n: raster[stage].length, t: [] });
    }
  }

  /** Instantaneous pathway rates from chroma + courtship drive. */
  function instantRates(chroma, drive, track) {
    const energy =
      chroma.reduce((a, b) => a + Number(b) || 0, 0) / Math.max(chroma.length, 1);
    const onset = Math.min(1.5, Number(track.onset_density_hz || 1) / 5);
    const bright = Math.min(1.2, Number(track.spectral_centroid_hz || 2000) / 8000);
    const bpmN = Math.min(1.4, Number(track.bpm || 100) / 120);
    return {
      ALPN: 40 + 180 * energy,
      Kenyon_Cell: 20 + 100 * onset + 40 * bright + 30 * energy,
      MBON: 30 + 70 * bpmN + 20 * (1 - Math.abs(energy - 0.15)),
      DAN: 15 + 220 * drive,
    };
  }

  function appendBrainSample(state, tMs, rates) {
    const stages = ["ALPN", "Kenyon_Cell", "MBON", "DAN"];
    stages.forEach((s) => {
      state.rate_curves[s].push(Math.round(rates[s] * 10) / 10);
      if (state.rate_curves[s].length > MAX_BINS) state.rate_curves[s].shift();
    });
    // Sparse Poisson-ish spikes into raster at this time
    stages.forEach((s) => {
      ensureRasterRows(state.raster, s, 18);
      const p = Math.min(0.75, rates[s] / 280);
      state.raster[s].forEach((row) => {
        if (Math.random() < p * 0.35) {
          row.t.push(Math.round(tMs * 10) / 10);
          if (row.t.length > 40) row.t.shift();
        }
        // Drop spikes older than window
        const t0 = Math.max(0, tMs - MAX_BINS * BIN_MS);
        row.t = row.t.filter((x) => x >= t0);
      });
    });
    // Re-base spike times so raster x-axis matches curve length window
    const tBase = Math.max(0, tMs - (state.rate_curves.ALPN.length - 1) * BIN_MS);
    state._tBase = tBase;
    state._tEnd = tMs;
  }

  function rebaseRasterForDisplay(state) {
    // FlyExperience maps spike times with t / t_run_ms. Set t_run to window.
    const t0 = state._tBase || 0;
    const t1 = state._tEnd || BIN_MS;
    const out = {};
    Object.keys(state.raster).forEach((s) => {
      out[s] = (state.raster[s] || []).map((row, i) => ({
        n: i,
        t: (row.t || []).map((tm) => Math.max(0, tm - t0)),
      }));
    });
    return { raster: out, tRunMs: Math.max(BIN_MS, t1 - t0) };
  }

  function ensureChrome(slot) {
    if (slot.dataset.loflyReady === "4") return;
    slot.innerHTML = `
      <div class="lofly-chrome">
        <span class="cap">live · hearing now (moment)</span>
        <div id="loflyPlaying" class="lofly-mix mono"></div>
        <div class="lofly-audio-wrap">
          <audio id="loflyAudio" controls preload="auto"></audio>
          <div class="mono lofly-audio-hint" id="loflyAudioHint">pick play to turn the fly on</div>
        </div>
        <span class="cap">courting · favorite (next up)</span>
        <div id="loflyCourting" class="lofly-mix mono"></div>
        <div class="lofly-audio-wrap lofly-court-audio-wrap">
          <audio id="loflyCourtAudio" controls preload="metadata"></audio>
          <div class="mono lofly-audio-hint" id="loflyCourtAudioHint">preview of courted partner</div>
        </div>
        <span class="cap">glancing · caught his eye</span>
        <div id="loflyGlancing" class="lofly-mix mono"></div>
        <span class="cap">scoring toggles</span>
        <div id="loflyToggles" class="lofly-toggles"></div>
        <span class="cap">chroma · this moment</span>
        <div class="chroma-grid" id="loflyChroma"></div>
        <span class="cap">pheromone space · 3 songs</span>
        <div class="stim-track lofly-court-track">
          <div class="stim-fill" id="loflyCourtFill"></div>
        </div>
        <div class="mono lofly-court-label" id="loflyCourtLabel"></div>
        <div id="loflyAlts" class="lofly-alts mono"></div>
        <span class="cap">set so far</span>
        <div id="loflyTicks" class="lofly-alts mono"></div>
      </div>`;
    slot.dataset.loflyReady = "4";
    delete slot.dataset.tttReady;
    delete slot.dataset.percReady;
  }

  const TOGGLE_META = [
    {
      key: "prefer_complement",
      label: "prefer complement",
      hint: "favor relative/adjacent over same-key",
    },
    {
      key: "novelty",
      label: "novelty",
      hint: "prefer underplayed tracks",
    },
    {
      key: "clash_penalty",
      label: "clash penalty",
      hint: "downrank Camelot clashes",
    },
    {
      key: "camelot_boost",
      label: "Camelot boost",
      hint: "boost complementary wheel moves",
    },
  ];

  function bindToggles() {
    const root = document.getElementById("loflyToggles");
    if (!root || !live || root.dataset.bound === "1") return;
    root.dataset.bound = "1";
    root.innerHTML = TOGGLE_META.map((m) => {
      const on = !!live.toggles[m.key];
      return `<label class="lofly-toggle" title="${escapeHtml(m.hint)}">
        <input type="checkbox" data-toggle="${m.key}" ${on ? "checked" : ""}/>
        <span>${escapeHtml(m.label)}</span>
      </label>`;
    }).join("");
    root.addEventListener("change", (e) => {
      const inp = e.target;
      if (!inp || !inp.dataset.toggle || !live) return;
      live.toggles[inp.dataset.toggle] = !!inp.checked;
      rescoreMoment();
      renderHud();
    });
  }

  function renderChroma(chroma) {
    const el = document.getElementById("loflyChroma");
    if (!el) return;
    const maxC = Math.max(0.01, ...chroma.map(Number));
    el.innerHTML = PITCH_NAMES.map((ch, i) => {
      const v = Number(chroma[i] || 0);
      const t = v / maxC;
      const bg = `color-mix(in srgb, ${tok("--violet")} ${Math.round(18 + t * 72)}%, var(--panel))`;
      return `<div class="chroma-cell" style="background:${bg}" title="${ch}: ${v.toFixed(3)}">
        <span class="chroma-note">${ch}</span>
      </div>`;
    }).join("");
  }

  let lastCourtAudioSrc = null;

  function syncCourtPreview(courting) {
    const el = document.getElementById("loflyCourtAudio");
    const hint = document.getElementById("loflyCourtAudioHint");
    if (!el) return;
    if (!courting || !courting.path) {
      el.removeAttribute("src");
      el.load();
      lastCourtAudioSrc = null;
      if (hint) hint.textContent = "no partner yet";
      return;
    }
    const src = resolveLibraryUrl(courting.path);
    if (!src || src === lastCourtAudioSrc) return;
    const wasPlaying = !el.paused;
    lastCourtAudioSrc = src;
    el.src = src;
    el.load();
    if (hint) {
      hint.textContent = `preview · ${courting.title || "partner"} → next if courtship holds`;
    }
    // Don't autoplay preview over the hearing stream; resume only if user already previewing
    if (wasPlaying) {
      el.play().catch(() => {});
    }
  }

  function renderHud() {
    if (!live) return;
    const { playing, courting, glancing, history, glanceCount, switches } = live;
    const ph = courting ? courting.pheromone : 0;
    const kind = courting ? courting.camelot_kind : "";
    const gph = glancing ? glancing.pheromone : 0;

    document.getElementById("loflyPlaying").innerHTML = `
      <div class="lofly-row">
        <span class="lofly-title">${escapeHtml(playing.title)}</span>
        <span class="lofly-badge">${escapeHtml(playing.camelot)}</span>
        <span class="lofly-bpm">${fmtBpm(playing.bpm)}</span>
      </div>
      <div class="lofly-bpm">${Number(playing.duration_s).toFixed(0)}s · moment chroma · glances ${glanceCount || 0}</div>`;

    document.getElementById("loflyCourting").innerHTML = courting
      ? `<div class="lofly-row">
          <span class="lofly-next">NEXT</span>
          <span class="lofly-title">${escapeHtml(courting.title)}</span>
          <span class="lofly-badge">${escapeHtml(courting.camelot)}</span>
          <span class="lofly-bpm">${fmtBpm(courting.bpm)}</span>
        </div>
        <div class="lofly-arrow ${kindClass(kind)}">${escapeHtml(kind)} · ph ${ph.toFixed(2)}</div>`
      : "—";

    syncCourtPreview(courting);

    const glanceEl = document.getElementById("loflyGlancing");
    if (glanceEl) {
      glanceEl.innerHTML = glancing
        ? `<div class="lofly-row">
            <span class="lofly-glance">EYE</span>
            <span class="lofly-title">${escapeHtml(glancing.title)}</span>
            <span class="lofly-badge">${escapeHtml(glancing.camelot)}</span>
            <span class="lofly-bpm">${fmtBpm(glancing.bpm)}</span>
          </div>
          <div class="lofly-arrow ${kindClass(glancing.camelot_kind)}">${escapeHtml(
            glancing.camelot_kind
          )} · ph ${gph.toFixed(2)}${
            gph > ph ? " · competing" : " · not enough"
          }</div>`
        : `<div class="lofly-bpm">waiting for next glance…</div>`;
    }

    const fill = document.getElementById("loflyCourtFill");
    fill.style.width = `${Math.round(ph * 100)}%`;
    fill.style.background = ph >= 0.85 ? tok("--green") : ph >= 0.5 ? tok("--amber") : tok("--coral");
    document.getElementById("loflyCourtLabel").textContent =
      `favorite ph ${(ph * 100).toFixed(0)}% · glance ${(gph * 100).toFixed(0)}% · ${switches} switches`;

    bindToggles();

    // Only the three songs in pheromone space
    const space = [];
    space.push({
      tag: "hear",
      title: playing.title,
      camelot: playing.camelot,
      kind: "—",
      pheromone: null,
    });
    if (courting) {
      space.push({
        tag: "court",
        title: courting.title,
        camelot: courting.camelot,
        kind: courting.camelot_kind,
        pheromone: courting.pheromone,
      });
    }
    if (glancing) {
      space.push({
        tag: "eye",
        title: glancing.title,
        camelot: glancing.camelot,
        kind: glancing.camelot_kind,
        pheromone: glancing.pheromone,
      });
    }
    document.getElementById("loflyAlts").innerHTML = space
      .map((a) => {
        const score =
          a.pheromone == null ? "stream" : `ph ${Number(a.pheromone).toFixed(2)}`;
        return `<div class="lofly-alt">
          <span class="lofly-alt-i">${a.tag}</span>
          <span class="lofly-badge sm">${escapeHtml(a.camelot || "")}</span>
          <span class="${kindClass(a.kind)}">${escapeHtml(a.kind)}</span>
          <span class="lofly-alt-title">${escapeHtml(a.title)}</span>
          <span class="lofly-alt-score">${score}</span>
        </div>`;
      })
      .join("");

    document.getElementById("loflyTicks").innerHTML = history.length
      ? history
          .slice(-8)
          .map(
            (h) => `<div class="lofly-alt">
            <span class="lofly-alt-i">${h.n}</span>
            <span class="lofly-badge sm">${escapeHtml(h.camelot || "")}</span>
            <span class="lofly-alt-title">${escapeHtml(h.title)}</span>
          </div>`
          )
          .join("")
      : "—";

    if (live.noteEl) {
      live.noteEl.innerHTML = `Live · hearing <span class="mono">${escapeHtml(
        playing.camelot
      )}</span>, courting <span class="mono">${escapeHtml(
        (courting && courting.camelot) || "—"
      )}</span>, glancing <span class="mono">${escapeHtml(
        (glancing && glancing.camelot) || "—"
      )}</span>
        <span class="outcome-pill win">ON</span>`;
    }
  }

  function pushBrainPanels() {
    if (!live || !live.hooks) return;
    const { raster, tRunMs } = rebaseRasterForDisplay(live.brain);
    const n = live.brain.rate_curves.ALPN.length;
    const last = (s) => {
      const c = live.brain.rate_curves[s];
      return c.length ? c[c.length - 1] : 0;
    };
    const stateData = {
      rate_curves: live.brain.rate_curves,
      raster,
      alpn_rate: last("ALPN"),
      kc_rate: last("Kenyon_Cell"),
      mbon_rate: last("MBON"),
      dan_rate: last("DAN"),
      stimulus: {
        channels: PITCH_NAMES,
        values: live.lastChroma || live.playing.chroma_mean,
      },
    };
    const meta = Object.assign({}, live.hooks.meta || {}, {
      t_run_ms: tRunMs,
      bin_ms: BIN_MS,
    });
    const FE = global.FlyExperience;
    if (!FE) return;
    FE.setStreamContext({
      cascadeSvg: live.hooks.cascadeSvg,
      rasterSvg: live.hooks.rasterSvg,
      legendEl: live.hooks.legendEl,
      stateData,
      meta,
      onProgress: (_f, sliced) => {
        driveAnatomy(sliced || stateData);
      },
    });
    // Curves already are the live stream — reveal fully
    FE.renderCascade(
      live.hooks.cascadeSvg,
      live.hooks.legendEl,
      stateData,
      meta,
      { streamFrac: n ? 1 : 0 }
    );
    FE.renderRaster(live.hooks.rasterSvg, stateData, meta, { streamFrac: n ? 1 : 0 });
    driveAnatomy(stateData);
  }

  function driveAnatomy(stateData) {
    if (!live || !live.hooks) return;
    if (typeof live.hooks.driveAnatomy === "function") {
      live.hooks.driveAnatomy(stateData);
      return;
    }
    if (live.hooks.skeletonPanel && live.hooks.skeletonPanel.update) {
      live.hooks.skeletonPanel.update(stateData);
    }
    if (live.hooks.eyemapPanel && live.hooks.eyemapPanel.update) {
      live.hooks.eyemapPanel.update(stateData);
    }
  }

  function excludeSet() {
    const cool = Math.max(8, Math.min(20, Math.floor(Object.keys(live.tracks).length / 10)));
    const recent = live.recent.slice(-cool);
    const ex = new Set(recent.concat([live.playing.id]));
    if (live.courting) ex.add(live.courting.track_id);
    return ex;
  }

  /** Re-score courting + glancing against the heard moment only (3-song space). */
  function rescoreMoment() {
    const L = global.LoFlyLive;
    if (!live || !live.playing) return;
    const hear = live.lastChroma || live.playing.chroma_mean;
    if (live.courting) {
      const tr = live.tracks[live.courting.track_id];
      if (tr) {
        const slice = live.courtGlimpseChroma || L.glimpseChroma(tr, rng);
        live.courtGlimpseChroma = slice;
        live.courting = L.scoreGlance(
          live.playing,
          hear,
          tr,
          slice,
          live.pc,
          live.toggles
        );
      }
    }
    if (live.glancing) {
      const tr = live.tracks[live.glancing.track_id];
      if (tr) {
        const slice = live.glanceChroma || L.glimpseChroma(tr, rng);
        live.glanceChroma = slice;
        live.glancing = L.scoreGlance(
          live.playing,
          hear,
          tr,
          slice,
          live.pc,
          live.toggles
        );
      }
    }
  }

  function maybeStealAttention() {
    const L = global.LoFlyLive;
    if (!live.courting || !live.glancing) return;
    if (live.glancing.pheromone > live.courting.pheromone + L.STICKY_MARGIN) {
      live.courting = Object.assign({}, live.glancing);
      live.courtGlimpseChroma = live.glanceChroma;
      live.switches += 1;
    }
  }

  /** Bring one new track into view; others stay out of pheromone space. */
  function takeGlance() {
    const L = global.LoFlyLive;
    const ids = L.eligibleIds(live.tracks, excludeSet());
    if (!ids.length) {
      live.glancing = null;
      live.glanceChroma = null;
      return;
    }
    const id = L.pickRandom(ids, rng);
    const tr = live.tracks[id];
    live.glanceChroma = L.glimpseChroma(tr, rng);
    const hear = live.lastChroma || live.playing.chroma_mean;
    live.glancing = L.scoreGlance(
      live.playing,
      hear,
      tr,
      live.glanceChroma,
      live.pc,
      live.toggles
    );
    live.glanceCount = (live.glanceCount || 0) + 1;
    maybeStealAttention();
  }

  function onSongProgress() {
    if (!live || !live.audio) return;
    const L = global.LoFlyLive;
    const audio = live.audio;
    const dur =
      (Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : live.playing.duration_s) || 1;
    const t = audio.currentTime;
    const progress = Math.max(0, Math.min(1, t / dur));
    // Short memory: only this moment of the song
    live.lastChroma = L.chromaAtProgress(live.playing, progress);
    renderChroma(live.lastChroma);
    rescoreMoment();

    const drive =
      (live.courting && live.courting.courtship && live.courting.courtship.courtship_drive) ||
      (live.courting && live.courting.pheromone) ||
      0;
    const rates = instantRates(live.lastChroma, drive, live.playing);
    const tMs = t * 1000;
    if (tMs - live.lastBinMs >= BIN_MS - 5) {
      live.lastBinMs = tMs;
      appendBrainSample(live.brain, tMs, rates);
      pushBrainPanels();
    }

    // Serial glances — one other song at a time
    const glanceEvery = L.GLANCE_SEC || 7;
    const glanceIdx = Math.floor(t / glanceEvery);
    while (live.glanceIdx < glanceIdx) {
      live.glanceIdx += 1;
      takeGlance();
    }
    renderHud();
  }

  function loadTrack(track, opts) {
    const L = global.LoFlyLive;
    live.playing = track;
    live.recent.push(track.id);
    live.pc.counts[track.id] = (live.pc.counts[track.id] || 0) + 1;
    live.pc.total = (live.pc.total || 0) + 1;
    live.switches = 0;
    live.glanceCount = 0;
    live.glanceIdx = -1;
    live.glancing = null;
    live.glanceChroma = null;
    live.brain = { rate_curves: emptyCurves(), raster: emptyRaster() };
    live.lastBinMs = -BIN_MS;
    live.lastChroma = L.chromaAtProgress(track, 0);

    // Start with one random favorite (not the whole crate ranked)
    const ids = L.eligibleIds(live.tracks, new Set([track.id]));
    if (ids.length) {
      const cid = L.pickRandom(ids, rng);
      const ctr = live.tracks[cid];
      live.courtGlimpseChroma = L.glimpseChroma(ctr, rng);
      live.courting = L.scoreGlance(
        track,
        live.lastChroma,
        ctr,
        live.courtGlimpseChroma,
        live.pc,
        live.toggles
      );
    } else {
      live.courting = null;
      live.courtGlimpseChroma = null;
    }

    live.history.push({
      n: live.history.length + 1,
      title: track.title,
      camelot: track.camelot,
      id: track.id,
    });

    // First glance so pheromone space is hear + court + eye
    takeGlance();
    live.glanceIdx = 0;

    const src = resolveLibraryUrl(track.path);
    const audio = live.audio;
    audio.src = src;
    audio.load();
    renderChroma(live.lastChroma);
    renderHud();
    pushBrainPanels();

    const hint = document.getElementById("loflyAudioHint");
    const tryPlay = () => {
      audio.play().then(() => {
        if (hint) hint.textContent = "live · moment chroma · one glance at a time";
      }).catch(() => {
        if (hint) hint.textContent = "press play — browser blocked autoplay";
      });
    };
    if (!opts || opts.autoplay !== false) tryPlay();
  }

  function advanceToCourted() {
    if (!live || !live.courting) return;
    const next = live.tracks[live.courting.track_id];
    if (!next) return;
    loadTrack(next, { autoplay: true });
  }

  function bindAudio() {
    const audio = live.audio;
    let raf = 0;
    const loop = () => {
      onSongProgress();
      if (!audio.paused && !audio.ended) raf = requestAnimationFrame(loop);
      else raf = 0;
    };
    audio.addEventListener("play", () => {
      if (!raf) raf = requestAnimationFrame(loop);
    });
    audio.addEventListener("pause", () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      onSongProgress();
    });
    audio.addEventListener("seeked", onSongProgress);
    audio.addEventListener("ended", () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      onSongProgress();
      advanceToCourted();
    });
  }

  function wireStepbar(hooks) {
    const label = hooks.labelEl;
    if (label) label.textContent = "live set";
    if (hooks.dotsEl) hooks.dotsEl.innerHTML = "";
    if (hooks.prevBtn) {
      hooks.prevBtn.disabled = false;
      hooks.prevBtn.onclick = () => {
        // skip: force next from current courtship
        if (live && live.audio) {
          live.audio.pause();
          advanceToCourted();
        }
      };
      hooks.prevBtn.setAttribute("aria-label", "Skip to courted partner");
      hooks.prevBtn.textContent = "skip →";
    }
    if (hooks.nextBtn) {
      hooks.nextBtn.disabled = false;
      hooks.nextBtn.onclick = () => {
        if (!live) return;
        const ids = Object.keys(live.tracks);
        const id = ids[Math.floor(Math.random() * ids.length)];
        loadTrack(live.tracks[id], { autoplay: true });
      };
      hooks.nextBtn.setAttribute("aria-label", "Random new song");
      hooks.nextBtn.textContent = "🎲";
    }
  }

  async function startLive(hooks) {
    ensureChrome(hooks.slot);
    if (!global.LoFlyLive) {
      hooks.noteEl.innerHTML =
        "Missing live_scoring.js — could not start live LoFly.";
      return;
    }

    let cat;
    try {
      const res = await fetch(LOFLY_BASE + "catalogue.json");
      if (!res.ok) throw new Error(res.statusText);
      cat = await res.json();
    } catch (err) {
      hooks.noteEl.innerHTML =
        "Failed to load catalogue.json — run catalogue.py first. " + err.message;
      return;
    }

    const tracks = cat.tracks || {};
    const ids = Object.keys(tracks);
    if (ids.length < 2) {
      hooks.noteEl.textContent = "Need ≥2 catalogued tracks.";
      return;
    }

    live = {
      hooks,
      tracks,
      pc: { counts: {}, total: 0 },
      toggles: Object.assign({}, global.LoFlyLive.DEFAULT_TOGGLES),
      recent: [],
      history: [],
      audio: document.getElementById("loflyAudio"),
      noteEl: hooks.noteEl,
      playing: null,
      courting: null,
      glancing: null,
      courtGlimpseChroma: null,
      glanceChroma: null,
      glanceCount: 0,
      glanceIdx: -1,
      ranked: [],
      tick: 0,
      nTicks: 3,
      switches: 0,
      brain: { rate_curves: emptyCurves(), raster: emptyRaster() },
      lastBinMs: -BIN_MS,
      lastChroma: null,
    };

    bindAudio();
    wireStepbar(hooks);

    if (hooks.tabsEl) {
      hooks.tabsEl.innerHTML =
        '<button class="tab active" type="button">live courtship</button>';
    }

    const startId = ids[Math.floor(Math.random() * ids.length)];
    loadTrack(tracks[startId], { autoplay: true });
  }

  /** Replay mount unused when startLive is present; keep for safety. */
  function mount() {}

  function episodeTabLabel() {
    return "live courtship";
  }

  function aboutHtml(meta) {
    const n =
      (meta.activity_payload && meta.activity_payload.catalogue_n) || "?";
    return `
      <div><strong style="color:var(--text)">Live:</strong> hears one song’s <em>current chroma moment</em>, courts one favorite, and glances at one other track at a time (~7s). Only those three occupy pheromone space.</div>
      <div><strong style="color:var(--text)">Memory:</strong> comparisons use timeline slices, not full-song means — selection is slower and stickier.</div>
      <div><strong style="color:var(--text)">Toggles:</strong> prefer complement, novelty, clash penalty, Camelot boost.</div>
      <div><strong style="color:var(--text)">Crate:</strong> ${n} tracks in memory; skip → locks partner; 🎲 new random song.</div>`;
  }

  global.FlyActivity = { startLive, mount, episodeTabLabel, aboutHtml };
})(window);
