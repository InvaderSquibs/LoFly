/**
 * Optic-lobe population spatial coverage — axial hex map (SVG).
 * Static anatomical reference; not wired to experience replay state.
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

  /** Flat-top axial (q,r) → pixel, matching the spec. */
  function axialToPixel(q, r, size) {
    const x = size * ((3 / 2) * q);
    const y = size * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r);
    return [x, y];
  }

  function hexPolygon(cx, cy, size) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i);
      pts.push(`${(cx + size * Math.cos(ang)).toFixed(2)},${(cy + size * Math.sin(ang)).toFixed(2)}`);
    }
    return pts.join(" ");
  }

  function createEyemapPanel(opts) {
    const { svgEl, selectEl, noteEl, legendEl } = opts;
    let data = null;
    let currentType = null;

    function colorScale(t) {
      // Orange → dark red
      const lo = "#f2a35e";
      const hi = "#7a1c1c";
      return lerpColor(lo, hi, Math.max(0, Math.min(1, t)));
    }

    function render() {
      if (!data || !currentType || !data.types[currentType]) {
        svgEl.innerHTML = "";
        return;
      }
      const entry = data.types[currentType];
      const cols = entry.columns || [];
      if (!cols.length) {
        svgEl.innerHTML = `<text x="12" y="24" font-size="12" fill="${cssVar("--text-dim", "#8496a1")}">No column assignments for ${currentType}</text>`;
        return;
      }

      const size = 7;
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
      const pad = size * 1.2;
      const width = maxX - minX + pad * 2;
      const height = maxY - minY + pad * 2;
      const maxV = Math.max(1, ...cols.map((c) => c.value));

      const parts = [];
      for (const c of laid) {
        const cx = c.x - minX + pad;
        const cy = c.y - minY + pad;
        const t = c.value / maxV;
        const fill = colorScale(t);
        parts.push(
          `<polygon points="${hexPolygon(cx, cy, size * 0.95)}" fill="${fill}" stroke="${cssVar("--hair", "#1c262d")}" stroke-width="0.4"><title>${currentType} · q=${c.q} r=${c.r} · ${c.value} neurons</title></polygon>`
        );
      }
      svgEl.setAttribute("viewBox", `0 0 ${width.toFixed(1)} ${height.toFixed(1)}`);
      svgEl.innerHTML = parts.join("");

      if (legendEl) {
        legendEl.innerHTML = `
          <span><span class="swatch" style="background:#f2a35e"></span>1</span>
          <span><span class="swatch" style="background:#c45c3e"></span></span>
          <span><span class="swatch" style="background:#7a1c1c"></span>${maxV}</span>
          <span style="color:var(--text-faint)">${entry.n_neurons} neurons · ${entry.n_columns} columns · ${entry.value_kind || "neuron_count"}</span>`;
      }
      if (noteEl) {
        noteEl.textContent =
          data.note ||
          "Static anatomical reference — optic-lobe columns are not driven by tic-tac-toe / odor replay.";
      }
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
    }

    return { init, render };
  }

  global.FlyEyemap = { createEyemapPanel, axialToPixel };
})(window);
