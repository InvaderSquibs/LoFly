/**
 * Optic-lobe population spatial coverage — axial hex map (SVG).
 * Anatomical column map (not per-column firing). Keeps true hex aspect via
 * preserveAspectRatio; optional ambient energy pulse from pathway rates so the
 * panel feels tied to the live feed without pretending OL columns spike.
 */
(function (global) {
  "use strict";

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function lerpColor(a, b, t) {
    const parse = (hex) => {
      const h = hex.replace("#", "");
      const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const A = parse(a),
      B = parse(b);
    const m = (i) => Math.round(A[i] + (B[i] - A[i]) * t);
    return `rgb(${m(0)},${m(1)},${m(2)})`;
  }

  /** Flat-top axial (q,r) → pixel. */
  function axialToPixel(q, r, size) {
    const x = size * ((3 / 2) * q);
    const y = size * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r);
    return [x, y];
  }

  function hexPolygon(cx, cy, size) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i);
      pts.push(
        `${(cx + size * Math.cos(ang)).toFixed(2)},${(cy + size * Math.sin(ang)).toFixed(2)}`
      );
    }
    return pts.join(" ");
  }

  function pathwayEnergy(stateData) {
    if (!stateData) return 0.35;
    const vals = [
      Number(stateData.alpn_rate) || 0,
      Number(stateData.kc_rate) || 0,
      Number(stateData.mbon_rate) || 0,
      Number(stateData.dan_rate) || 0,
    ];
    const mean = vals.reduce((a, b) => a + b, 0) / 4;
    return Math.max(0.2, Math.min(1, mean / 180));
  }

  function createEyemapPanel(opts) {
    const { svgEl, selectEl, noteEl, legendEl } = opts;
    let data = null;
    let currentType = null;
    let energy = 0.35;
    let layout = null; // cached geometry for recolor without relayout
    let animId = 0;
    let t0 = performance.now();

    function colorScale(t, pulse) {
      const lo = "#f2a35e";
      const hi = "#7a1c1c";
      const u = Math.max(0, Math.min(1, t));
      // Pulse lifts midtones slightly with pathway energy (ambient, not column spikes).
      const lifted = Math.min(1, u * (0.75 + 0.35 * pulse));
      return lerpColor(lo, hi, lifted);
    }

    function layoutColumns(cols) {
      const size = 8;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      const laid = cols.map((c) => {
        const [x, y] = axialToPixel(c.q, c.r, size);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        return { ...c, x, y };
      });
      const pad = size * 1.35;
      return {
        laid,
        size,
        pad,
        minX,
        minY,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
        maxV: Math.max(1, ...cols.map((c) => c.value)),
      };
    }

    function paint() {
      if (!layout) return;
      const pulse =
        energy * (0.85 + 0.15 * Math.sin((performance.now() - t0) * 0.004));
      // Ambient only: scale whole map opacity — column fills stay anatomical.
      const g = svgEl.querySelector("g.eyemap-cells");
      if (g) g.setAttribute("opacity", (0.55 + 0.45 * pulse).toFixed(3));
    }

    function render() {
      if (!data || !currentType || !data.types[currentType]) {
        svgEl.innerHTML = "";
        layout = null;
        return;
      }
      const entry = data.types[currentType];
      const cols = entry.columns || [];
      if (!cols.length) {
        layout = null;
        svgEl.innerHTML = `<text x="12" y="24" font-size="12" fill="${cssVar("--text-dim", "#8496a1")}">No column assignments for ${currentType}</text>`;
        return;
      }

      layout = layoutColumns(cols);
      svgEl.setAttribute(
        "viewBox",
        `0 0 ${layout.width.toFixed(1)} ${layout.height.toFixed(1)}`
      );
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svgEl.removeAttribute("height");
      svgEl.setAttribute("width", "100%");

      const parts = ['<g class="eyemap-cells" opacity="0.85">'];
      for (const c of layout.laid) {
        const cx = c.x - layout.minX + layout.pad;
        const cy = c.y - layout.minY + layout.pad;
        const t = c.value / layout.maxV;
        const fill = colorScale(t, 1);
        parts.push(
          `<polygon points="${hexPolygon(cx, cy, layout.size * 0.95)}" fill="${fill}" stroke="${cssVar("--hair", "#1c262d")}" stroke-width="0.45"><title>${currentType} · q=${c.q} r=${c.r} · ${c.value} neurons</title></polygon>`
        );
      }
      parts.push("</g>");
      svgEl.innerHTML = parts.join("");
      paint();

      if (legendEl) {
        legendEl.innerHTML = `
          <span><span class="swatch" style="background:#f2a35e"></span>1</span>
          <span><span class="swatch" style="background:#c45c3e"></span></span>
          <span><span class="swatch" style="background:#7a1c1c"></span>${layout.maxV}</span>
          <span style="color:var(--text-faint)">${entry.n_neurons} neurons · ${entry.n_columns} columns · ambient pulse from pathway</span>`;
      }
      if (noteEl) {
        noteEl.textContent =
          (data.note ? data.note + " " : "") +
          "Column colors are anatomical counts; overall glow follows live pathway energy (not optic-lobe spikes).";
      }
    }

    function tick() {
      animId = requestAnimationFrame(tick);
      if (layout) paint();
    }

    function update(stateData) {
      energy = pathwayEnergy(stateData);
    }

    async function init() {
      const res = await fetch(opts.dataUrl || "data/optic_lobe_hexmap.json");
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      data = await res.json();
      currentType = data.default_type || (data.available_types && data.available_types[0]);
      if (selectEl) {
        const types = data.available_types || Object.keys(data.types || {});
        selectEl.innerHTML = types
          .map(
            (t) =>
              `<option value="${t}"${t === currentType ? " selected" : ""}>${t}</option>`
          )
          .join("");
        selectEl.addEventListener("change", () => {
          currentType = selectEl.value;
          render();
        });
      }
      render();
      cancelAnimationFrame(animId);
      animId = requestAnimationFrame(tick);
    }

    return { init, render, update };
  }

  global.FlyEyemap = { createEyemapPanel, axialToPixel };
})(window);
