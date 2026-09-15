/**
 * Shared fly-experience panels: cascade, raster, learning curve, step chrome.
 * Activity-agnostic — reads TrialExperience + ExperienceReplay.learning.
 */
(function (global) {
  "use strict";

  function T(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const STAGE_COLORS = {
    ALPN: "--cyan",
    Kenyon_Cell: "--violet",
    MBON: "--amber",
    DAN: "--green",
  };

  function stagesFrom(meta) {
    return (meta && meta.stages) || ["ALPN", "Kenyon_Cell", "MBON", "DAN"];
  }

  function stageLabels(meta) {
    return (
      (meta && meta.stage_labels) || {
        ALPN: "ALPN",
        Kenyon_Cell: "Kenyon cell",
        MBON: "MBON",
        DAN: "DAN",
      }
    );
  }

  function stageMeanRate(stateData, stage) {
    const map = {
      ALPN: "alpn_rate",
      Kenyon_Cell: "kc_rate",
      MBON: "mbon_rate",
      DAN: "dan_rate",
    };
    const key = map[stage];
    if (key && stateData[key] != null) return Number(stateData[key]);
    const curve = (stateData.rate_curves || {})[stage];
    if (curve && curve.length) {
      return curve.reduce((a, b) => a + b, 0) / curve.length;
    }
    return 0;
  }

  function renderCascade(svgEl, legendEl, stateData, meta) {
    const stages = stagesFrom(meta);
    const labels = stageLabels(meta);
    const tRun = (meta && meta.t_run_ms) || 150;
    const W = 520,
      H = 150,
      padL = 28,
      padR = 8,
      padT = 8,
      padB = 18;
    const plotW = W - padL - padR,
      plotH = H - padT - padB;

    let maxY = 1;
    stages.forEach((s) => {
      const c = (stateData.rate_curves || {})[s] || [];
      c.forEach((v) => {
        if (v > maxY) maxY = v;
      });
    });
    maxY *= 1.08;

    const svgParts = [];
    svgParts.push(
      `<line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>`
    );
    svgParts.push(
      `<line class="axis-line" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>`
    );

    const nBins = Math.max(
      1,
      ...stages.map((s) => ((stateData.rate_curves || {})[s] || []).length)
    );
    const xAt = (i) => padL + (plotW * i) / Math.max(1, nBins - 1);
    const yAt = (v) => padT + plotH * (1 - v / maxY);

    stages.forEach((s) => {
      const curve = (stateData.rate_curves || {})[s] || [];
      if (!curve.length) return;
      const color = T(STAGE_COLORS[s] || "--cyan");
      const pts = curve
        .map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
        .join(" ");
      svgParts.push(
        `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" opacity="0.95" stroke-linejoin="round"/>`
      );
    });

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(tRun * f));
    ticks.forEach((t) => {
      const x = padL + plotW * (t / tRun);
      svgParts.push(
        `<text x="${x}" y="${H - 2}" font-size="9" text-anchor="middle" fill="${T("--text-faint")}">${t}</text>`
      );
    });

    svgEl.innerHTML = svgParts.join("");

    if (legendEl) {
      legendEl.innerHTML = stages
        .map((s) => {
          const hz = stageMeanRate(stateData, s).toFixed(1);
          return `<span><span class="swatch" style="background:${T(STAGE_COLORS[s] || "--cyan")}"></span>${labels[s] || s} &middot; ${hz}Hz</span>`;
        })
        .join("");
    }
  }

  function renderRaster(svgEl, stateData, meta) {
    const stages = stagesFrom(meta);
    const labels = stageLabels(meta);
    const tRun = (meta && meta.t_run_ms) || 150;
    const W = 520,
      H = 168,
      padL = 76,
      padR = 8,
      padT = 6,
      padB = 16;
    const plotW = W - padL - padR,
      plotH = H - padT - padB;
    const bandH = plotH / stages.length;
    const parts = [];

    stages.forEach((s, bi) => {
      const y0 = padT + bi * bandH;
      const color = T(STAGE_COLORS[s] || "--cyan");
      parts.push(
        `<rect x="${padL}" y="${y0 + 1}" width="${plotW}" height="${bandH - 3}" fill="${color}" opacity="0.045"/>`
      );
      parts.push(
        `<text x="6" y="${y0 + bandH / 2 + 3}" font-size="9.5" fill="${color}">${labels[s] || s}</text>`
      );
      const rows = (stateData.raster || {})[s] || [];
      const n = Math.max(1, rows.length);
      rows.forEach((row, ri) => {
        const times = row && row.t ? row.t : Array.isArray(row) ? row : [];
        const rowY = y0 + 2 + ((bandH - 4) * ri) / n;
        times.forEach((tms) => {
          const x = padL + plotW * (tms / tRun);
          parts.push(
            `<line x1="${x.toFixed(1)}" y1="${rowY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(rowY + ((bandH - 4) / n) * 0.9).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.85"/>`
          );
        });
      });
    });

    const tickVals = [0, 0.33, 0.66, 1].map((f) => Math.round(tRun * f));
    tickVals.forEach((t) => {
      const x = padL + plotW * (t / tRun);
      parts.push(
        `<text x="${x}" y="${H - 2}" font-size="9" text-anchor="middle" fill="${T("--text-faint")}">${t}</text>`
      );
    });

    svgEl.innerHTML = parts.join("");
  }

  function renderLearning(svgEl, summaryEl, learning) {
    if (!learning || !learning.outcomes || !learning.outcomes.length) {
      if (svgEl) svgEl.innerHTML = "";
      if (summaryEl) {
        summaryEl.textContent =
          "No learning series for this activity — experience panels still show pathway dynamics per trial.";
      }
      return;
    }

    const W = 1080,
      H = 210,
      padL = 34,
      padR = 12,
      padT = 14,
      padB = 34;
    const plotW = W - padL - padR,
      plotH = H - padT - padB;
    const n = learning.outcomes.length;
    const parts = [];
    parts.push(
      `<line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>`
    );
    parts.push(
      `<line class="axis-line" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>`
    );
    [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
      const y = padT + plotH * (1 - f);
      parts.push(
        `<text x="${padL - 6}" y="${y + 3}" font-size="9" text-anchor="end" fill="${T("--text-faint")}">${Math.round(f * 100)}%</text>`
      );
      parts.push(
        `<line class="axis-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke-dasharray="1,3"/>`
      );
    });

    const xAt = (i) => padL + (plotW * i) / Math.max(1, n - 1);

    if (learning.reference) {
      const refY = padT + plotH * (1 - learning.reference.y);
      parts.push(
        `<line x1="${padL}" y1="${refY}" x2="${W - padR}" y2="${refY}" stroke="${T("--text-faint")}" stroke-width="1" stroke-dasharray="4,4" opacity="0.6"/>`
      );
      parts.push(
        `<text x="${W - padR}" y="${refY - 4}" font-size="9" text-anchor="end" fill="${T("--text-faint")}">${learning.reference.label}</text>`
      );
    }

    function line(series, color, width, opacity) {
      if (!series || !series.length) return;
      const pts = series
        .map((v, i) => `${xAt(i).toFixed(1)},${(padT + plotH * (1 - v)).toFixed(1)}`)
        .join(" ");
      parts.push(
        `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linejoin="round"/>`
      );
    }
    line(learning.cumulative, T("--text-faint"), 1.4, 0.6);
    line(learning.rolling, T("--green"), 2.2, 0.95);

    const tickY = H - padB + 6;
    learning.outcomes.forEach((o, i) => {
      const color =
        o === "win" || o === "correct"
          ? T("--green")
          : o === "loss" || o === "incorrect"
            ? T("--coral")
            : T("--text-faint");
      const op = o === "draw" ? 0.35 : 0.85;
      parts.push(
        `<line x1="${xAt(i).toFixed(1)}" y1="${tickY}" x2="${xAt(i).toFixed(1)}" y2="${tickY + 8}" stroke="${color}" stroke-width="1.3" opacity="${op}"/>`
      );
    });

    [0, Math.round(n * 0.25), Math.round(n * 0.5), Math.round(n * 0.75), n - 1].forEach(
      (i) => {
        parts.push(
          `<text x="${xAt(i).toFixed(1)}" y="${H - 4}" font-size="9" text-anchor="middle" fill="${T("--text-faint")}">${i + 1}</text>`
        );
      }
    );

    svgEl.innerHTML = parts.join("");

    if (summaryEl && learning.rolling && learning.rolling.length) {
      const last = learning.rolling[learning.rolling.length - 1];
      summaryEl.textContent = `Rolling window (bold) ends at ${(last * 100).toFixed(0)}% by episode ${n}; thin line is cumulative rate across all ${n} episodes.`;
    }
  }

  function renderStepControls(opts) {
    const { step, nSteps, dotsEl, labelEl, prevBtn, nextBtn, onSelect } = opts;
    if (dotsEl) {
      dotsEl.innerHTML = "";
      for (let i = 0; i < nSteps; i++) {
        const d = document.createElement("div");
        d.className = "stepdot" + (i === step ? " active" : "");
        d.setAttribute("role", "button");
        d.setAttribute("aria-label", "Go to step " + (i + 1));
        d.tabIndex = 0;
        d.addEventListener("click", () => onSelect(i));
        d.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") onSelect(i);
        });
        dotsEl.appendChild(d);
      }
    }
    if (labelEl) labelEl.textContent = `step ${step + 1} / ${nSteps}`;
    if (prevBtn) prevBtn.disabled = step === 0;
    if (nextBtn) nextBtn.disabled = step >= nSteps - 1;
  }

  global.FlyExperience = {
    T,
    STAGE_COLORS,
    renderCascade,
    renderRaster,
    renderLearning,
    renderStepControls,
    stageMeanRate,
  };
})(window);
