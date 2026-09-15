/**
 * LoFly live mode — random song at start, court while it plays,
 * stream pathway activity from the song (not a frozen trial replay).
 */
(function (global) {
  "use strict";

  const LOFLY_BASE = "activities/lofly/";
  const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BIN_MS = 250;
  const MAX_BINS = 480;
  const BRIAN_T_RUN_MS = 150;

  let live = null;
  let listeningBank = null; // { tracks: { id: { quiet, hot, hot_drive } } }

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
      <div class="lofly-bpm">${Number(playing.duration_s).toFixed(0)}s · real 0.2s chroma · 7s memory · glances ${glanceCount || 0} · ${
        live.brainSource === "brian2" ? "Brian2" : "stand-in"
      }</div>`;

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

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function blendSims(quiet, hot, drive, hotDrive) {
    const t = Math.max(0, Math.min(1, drive / Math.max(0.01, hotDrive || 0.75)));
    const stages = ["ALPN", "Kenyon_Cell", "MBON", "DAN"];
    const rate_curves = {};
    stages.forEach((s) => {
      const a = (quiet.rate_curves && quiet.rate_curves[s]) || [];
      const b = (hot.rate_curves && hot.rate_curves[s]) || [];
      const n = Math.max(a.length, b.length);
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(Math.round(lerp(a[i] || 0, b[i] || 0, t) * 10) / 10);
      }
      rate_curves[s] = out;
    });
    // Prefer hot raster when drive high (real Brian2 spikes)
    const raster = t >= 0.45 ? hot.raster || quiet.raster : quiet.raster || hot.raster;
    return {
      rate_curves,
      raster: raster || {},
      alpn_rate: lerp(quiet.alpn_rate || 0, hot.alpn_rate || 0, t),
      kc_rate: lerp(quiet.kc_rate || 0, hot.kc_rate || 0, t),
      mbon_rate: lerp(quiet.mbon_rate || 0, hot.mbon_rate || 0, t),
      dan_rate: lerp(quiet.dan_rate || 0, hot.dan_rate || 0, t),
      source: "brian2",
      blend: t,
    };
  }

  function bankEntryFor(trackId) {
    if (!listeningBank || !listeningBank.tracks) return null;
    return listeningBank.tracks[trackId] || null;
  }

  /** Push Brian2 curves scrubbed to song progress (real subgraph activity). */
  function pushBrianPanels(songFrac, drive) {
    if (!live || !live.hooks || !live.playing) return false;
    const entry = bankEntryFor(live.playing.id);
    if (!entry || !entry.quiet || !entry.hot) return false;

    const blended = blendSims(entry.quiet, entry.hot, drive, entry.hot_drive);
    const frac = Math.max(0, Math.min(1, songFrac));
    const stateData = {
      rate_curves: blended.rate_curves,
      raster: blended.raster,
      alpn_rate: blended.alpn_rate,
      kc_rate: blended.kc_rate,
      mbon_rate: blended.mbon_rate,
      dan_rate: blended.dan_rate,
      stimulus: {
        channels: PITCH_NAMES,
        values: live.lastChroma || live.playing.chroma_mean,
      },
      brain_source: "brian2",
    };
    const meta = Object.assign({}, live.hooks.meta || {}, {
      t_run_ms: BRIAN_T_RUN_MS,
      bin_ms: 3,
    });
    const FE = global.FlyExperience;
    if (!FE) return false;
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
    FE.setStreamProgress(frac);
    live.brainSource = "brian2";
    return true;
  }

  function pushStandinPanels() {
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
      brain_source: "standin",
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
    FE.renderCascade(
      live.hooks.cascadeSvg,
      live.hooks.legendEl,
      stateData,
      meta,
      { streamFrac: n ? 1 : 0 }
    );
    FE.renderRaster(live.hooks.rasterSvg, stateData, meta, { streamFrac: n ? 1 : 0 });
    driveAnatomy(stateData);
    live.brainSource = "standin";
  }

  function driveAnatomy(stateData) {
    if (!live || !live.hooks) return;
    if (typeof live.hooks.driveAnatomy === "function") {
      live.hooks.driveAnatomy(stateData);
    } else {
      if (live.hooks.skeletonPanel && live.hooks.skeletonPanel.update) {
        live.hooks.skeletonPanel.update(stateData);
      }
    }
    pushEyemapChroma();
  }

  function pushEyemapChroma() {
    if (!live || !live.hooks || !live.hooks.eyemapPanel) return;
    const panel = live.hooks.eyemapPanel;
    const L = global.LoFlyLive;
    const track = live.playing;
    if (!track) return;

    // Chromagram image under the playhead: time × 12 pitches (memory window)
    const t =
      live.audio && Number.isFinite(live.audio.currentTime)
        ? live.audio.currentTime
        : 0;
    const win = (L && L.MEMORY_SEC) || 7;
    const slice = (L && L.CHROMA_SLICE_SEC) || 0.2;
    const n = Math.max(1, Math.round(win / slice));
    const t0 = Math.max(0, t - win);
    const data = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) {
      const ti = t0 + ((i + 0.5) / n) * Math.min(win, t + 1e-6);
      const row = L.chromaAtTime(track, ti);
      for (let p = 0; p < 12; p++) data[i * 12 + p] = Number(row[p]) || 0;
    }

    if (typeof panel.setChromaImage === "function") {
      panel.setChromaImage({ w: n, h: 12, data });
    } else if (typeof panel.setChromaFields === "function") {
      panel.setChromaFields({
        hear: live.lastChroma,
        court: live.courtGlimpseChroma,
        eye: live.glanceChroma,
      });
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

  function maybeStealAttention(hearChroma, courtChroma, eyeChroma) {
    const L = global.LoFlyLive;
    if (!live.courting || !live.glancing) return false;
    let margin = L.STICKY_MARGIN;
    if (hearChroma && eyeChroma && courtChroma) {
      const dEye = chromaDist12(hearChroma, eyeChroma);
      const dCourt = chromaDist12(hearChroma, courtChroma);
      if (dEye + 0.04 < dCourt) margin *= 0.55;
      else if (dCourt + 0.04 < dEye) margin *= 1.35;
    }
    if (live.glancing.pheromone > live.courting.pheromone + margin) {
      live.courting = Object.assign({}, live.glancing);
      live.courtGlimpseChroma = eyeChroma || live.glanceChroma;
      live.switches += 1;
      return true;
    }
    return false;
  }

  function chromaDist12(a, b) {
    if (!a || !b) return 0.5;
    let na = 0,
      nb = 0,
      dot = 0;
    for (let i = 0; i < 12; i++) {
      const x = Number(a[i]) || 0;
      const y = Number(b[i]) || 0;
      na += x * x;
      nb += y * y;
      dot += x * y;
    }
    na = Math.sqrt(na);
    nb = Math.sqrt(nb);
    if (na < 1e-9 || nb < 1e-9) return 0.5;
    const cos = Math.max(-1, Math.min(1, dot / (na * nb)));
    return 0.5 * (1 - cos);
  }

  function pushMemorySample(t) {
    if (!live) return;
    live.memory = live.memory || [];
    live.memory.push({
      t,
      hear: (live.lastChroma || []).slice(),
      court: (live.courtGlimpseChroma || []).slice(),
      eye: (live.glanceChroma || []).slice(),
    });
    const memSec = (global.LoFlyLive && global.LoFlyLive.MEMORY_SEC) || 7;
    const cutoff = t - memSec;
    while (live.memory.length && live.memory[0].t < cutoff) live.memory.shift();
  }

  /** End of 7s window: decide from memory, then bring a new song into sight. */
  function decideFromMemoryAndGlance(t) {
    const L = global.LoFlyLive;
    if (live.memory && live.memory.length && live.courting && live.glancing) {
      const hearAvg = L.meanChroma(live.memory.map((m) => m.hear));
      const courtAvg = L.meanChroma(live.memory.map((m) => m.court));
      const eyeAvg = L.meanChroma(live.memory.map((m) => m.eye));
      const courtTr = live.tracks[live.courting.track_id];
      const eyeTr = live.tracks[live.glancing.track_id];
      if (courtTr) {
        live.courtGlimpseChroma = courtAvg;
        live.courting = L.scoreGlance(
          live.playing,
          hearAvg,
          courtTr,
          courtAvg,
          live.pc,
          live.toggles
        );
      }
      if (eyeTr) {
        live.glanceChroma = eyeAvg;
        live.glancing = L.scoreGlance(
          live.playing,
          hearAvg,
          eyeTr,
          eyeAvg,
          live.pc,
          live.toggles
        );
      }
      maybeStealAttention(hearAvg, courtAvg, eyeAvg);
    }
    live.memory = [];
    takeGlance(t, { decide: false });
  }

  /** Bring one new track into view. Decision happens only after MEMORY_SEC. */
  function takeGlance(t, opts) {
    const L = global.LoFlyLive;
    const ids = L.eligibleIds(live.tracks, excludeSet());
    if (!ids.length) {
      live.glancing = null;
      live.glanceChroma = null;
      return;
    }
    const id = L.pickRandom(ids, rng);
    const tr = live.tracks[id];
    const at = t != null ? t : (live.audio && live.audio.currentTime) || 0;
    live.glanceStartT = at;
    live.glanceLocal = 0;
    live.glanceChroma = L.chromaAtTime(tr, at);
    const hear = live.lastChroma || L.chromaAtTime(live.playing, at);
    live.glancing = L.scoreGlance(
      live.playing,
      hear,
      tr,
      live.glanceChroma,
      live.pc,
      live.toggles
    );
    live.glanceCount = (live.glanceCount || 0) + 1;
    live.memory = [];
    if (opts && opts.decide) maybeStealAttention(hear, live.courtGlimpseChroma, live.glanceChroma);
    pushEyemapChroma();
  }

  function onSongProgress() {
    if (!live || !live.audio || !live.playing) return;
    const L = global.LoFlyLive;
    const audio = live.audio;
    const dur =
      (Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : live.playing.duration_s) || 1;
    const t = audio.currentTime;
    const progress = Math.max(0, Math.min(1, t / dur));
    const sliceSec = L.CHROMA_SLICE_SEC || 0.2;
    const memSec = L.MEMORY_SEC || 7;

    // Pass-through playhead chroma (0.2s catalogue slices, lerped). No looping.
    live.lastChroma = L.chromaAtTime(live.playing, t);
    if (live.courting) {
      const ctr = live.tracks[live.courting.track_id];
      if (ctr) live.courtGlimpseChroma = L.chromaAtTime(ctr, t);
    }
    if (live.glancing) {
      const gtr = live.tracks[live.glancing.track_id];
      if (gtr) live.glanceChroma = L.chromaAtTime(gtr, t);
    }
    live.glanceLocal = Math.max(
      0,
      Math.min(0.999, Math.max(0, t - (live.glanceStartT || 0)) / memSec)
    );
    renderChroma(live.lastChroma);
    pushEyemapChroma();

    // Pause freezes evaluation — memory, decisions, brain only advance while playing
    if (audio.paused || audio.ended) {
      renderHud();
      return;
    }

    rescoreMoment();

    if (live.lastSliceT == null || t - live.lastSliceT >= sliceSec - 1e-3) {
      live.lastSliceT = t;
      pushMemorySample(t);
    }

    if (live.glanceStartT == null) live.glanceStartT = t;
    if (t - live.glanceStartT >= memSec - 1e-3) {
      decideFromMemoryAndGlance(t);
    }

    const drive =
      (live.courting && live.courting.courtship && live.courting.courtship.courtship_drive) ||
      (live.courting && live.courting.pheromone) ||
      0;

    if (!pushBrianPanels(progress, drive)) {
      const rates = instantRates(live.lastChroma, drive, live.playing);
      const tMs = t * 1000;
      if (tMs - live.lastBinMs >= sliceSec * 1000 - 5) {
        live.lastBinMs = tMs;
        appendBrainSample(live.brain, tMs, rates);
        pushStandinPanels();
      }
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
    live.glancing = null;
    live.glanceChroma = null;
    live.glanceStartT = 0;
    live.glanceLocal = 0;
    live.memory = [];
    live.lastSliceT = null;
    live.brain = { rate_curves: emptyCurves(), raster: emptyRaster() };
    live.lastBinMs = -BIN_MS;
    live.lastChroma = L.chromaAtTime(track, 0);

    // Start with one random favorite (not the whole crate ranked)
    const ids = L.eligibleIds(live.tracks, new Set([track.id]));
    if (ids.length) {
      const cid = L.pickRandom(ids, rng);
      const ctr = live.tracks[cid];
      live.courtGlimpseChroma = L.chromaAtTime(ctr, 0);
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
    takeGlance(0);

    const src = resolveLibraryUrl(track.path);
    const audio = live.audio;
    audio.src = src;
    audio.load();
    renderChroma(live.lastChroma);
    renderHud();
    const drive0 =
      (live.courting && live.courting.courtship && live.courting.courtship.courtship_drive) ||
      0;
    if (!pushBrianPanels(0, drive0)) pushStandinPanels();

    const hint = document.getElementById("loflyAudioHint");
    const hasBrian = !!bankEntryFor(track.id);
    const tryPlay = () => {
      audio.play().then(() => {
        if (hint) {
          hint.textContent = hasBrian
            ? "Brian2 pathway · scrubbed with the song"
            : "stand-in rates · Brian2 bank missing for this track";
        }
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

  function setAnatomyActive(on) {
    if (!live || !live.hooks) return;
    const active = !!on;
    if (live.hooks.skeletonPanel && live.hooks.skeletonPanel.setActive) {
      live.hooks.skeletonPanel.setActive(active);
    }
    if (live.hooks.eyemapPanel && live.hooks.eyemapPanel.setActive) {
      live.hooks.eyemapPanel.setActive(active);
    }
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
      setAnatomyActive(true);
      pushEyemapChroma();
      if (!raf) raf = requestAnimationFrame(loop);
    });
    audio.addEventListener("pause", () => {
      setAnatomyActive(false);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      onSongProgress();
    });
    audio.addEventListener("seeked", onSongProgress);
    audio.addEventListener("ended", () => {
      setAnatomyActive(false);
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
        const all = Object.keys(live.tracks);
        const banked = listeningBank
          ? all.filter((id) => listeningBank.tracks && listeningBank.tracks[id])
          : [];
        const pool = banked.length ? banked : all;
        const id = pool[Math.floor(Math.random() * pool.length)];
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

    try {
      const br = await fetch(LOFLY_BASE + "listening_bank.json");
      if (br.ok) listeningBank = await br.json();
    } catch (_) {
      listeningBank = null;
    }

    const tracks = cat.tracks || {};
    const ids = Object.keys(tracks);
    if (ids.length < 2) {
      hooks.noteEl.textContent = "Need ≥2 catalogued tracks.";
      return;
    }

    const bankIds = listeningBank
      ? ids.filter((id) => listeningBank.tracks && listeningBank.tracks[id])
      : [];

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
      glanceStartT: 0,
      glanceLocal: 0,
      memory: [],
      lastSliceT: null,
      ranked: [],
      tick: 0,
      nTicks: 3,
      switches: 0,
      brain: { rate_curves: emptyCurves(), raster: emptyRaster() },
      brainSource: "standin",
      lastBinMs: -BIN_MS,
      lastChroma: null,
    };

    bindAudio();
    wireStepbar(hooks);

    if (hooks.tabsEl) {
      const nBank = bankIds.length;
      hooks.tabsEl.innerHTML = `<button class="tab active" type="button">live · Brian2 bank ${nBank}/${ids.length}</button>`;
    }

    // Prefer a track that already has Brian2 fingerprints
    const pool = bankIds.length ? bankIds : ids;
    const startId = pool[Math.floor(Math.random() * pool.length)];
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
      <div><strong style="color:var(--text)">Live:</strong> chroma follows the playhead (0.2s slices). Pause the song → evaluation freezes. After 7s of playback memory, keep the eye as NEXT or glance elsewhere.</div>
      <div><strong style="color:var(--text)">Eyemap:</strong> each of ~892 hexes samples a UV tile of the playing chromagram (equal split + overlap). Color = UV spectrum by local pitch; brightness = energy. Follows the playhead.</div>
      <div><strong style="color:var(--text)">Toggles:</strong> prefer complement, novelty, clash penalty, Camelot boost.</div>
      <div><strong style="color:var(--text)">Crate:</strong> ${n} tracks in memory; skip → locks partner; 🎲 new random song.</div>`;
  }

  global.FlyActivity = { startLive, mount, episodeTabLabel, aboutHtml };
})(window);
