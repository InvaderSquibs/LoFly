/**
 * Optic-lobe hex map (SVG).
 *
 * Base fill = anatomical neuron counts per column.
 * Live LoFly: each hex samples a UV patch of the chromagram image
 * (equal tile + slight overlap) and lights on a UV-ish spectral colormap.
 * Live FX: each hex samples a UV patch of a website raster and fills with
 * the average RGB of that overlapping pixel grid.
 */
(function (global) {
  "use strict";

  const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const OVERLAP = 1.2; // tile size multiplier → slight neighbor overlap

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

  /** UV-spectrum RGB: violet → indigo → cyan by pitch, scaled by intensity. */
  function uvSpectrumRgb(pitch01, intensity) {
    const t = Math.max(0, Math.min(1, pitch01));
    const a = Math.max(0, Math.min(1, intensity));
    const hue = (275 - t * 100) / 360;
    const sat = 0.55 + 0.4 * a;
    const lit = 0.12 + 0.55 * a;
    return hslToRgb(hue, sat, lit);
  }

  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s < 1e-6) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  /**
   * Chromagram image: width = time, height = 12 pitches.
   * data = Float32 row-major [t * 12 + pitch]
   */
  function samplePatch(img, u, v, ru, rv) {
    if (!img || !img.data || !img.w || !img.h) {
      return { energy: 0, pitch01: 0, bins: null };
    }
    const w = img.w;
    const h = img.h;
    const x0 = Math.max(0, Math.floor((u - ru) * w));
    const x1 = Math.min(w - 1, Math.ceil((u + ru) * w));
    const y0 = Math.max(0, Math.floor((v - rv) * h));
    const y1 = Math.min(h - 1, Math.ceil((v + rv) * h));
    const bins = Array(12).fill(0);
    let n = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const pitch =
          h <= 12 ? Math.min(11, y) : Math.min(11, Math.round((y / Math.max(1, h - 1)) * 11));
        const val = Number(img.data[x * 12 + pitch]) || 0;
        bins[pitch] += val;
        n += 1;
      }
    }
    if (n < 1) return { energy: 0, pitch01: 0, bins };
    let energy = 0;
    let weighted = 0;
    let mass = 0;
    for (let i = 0; i < 12; i++) {
      const b = bins[i] / n;
      bins[i] = b;
      energy += b;
      weighted += b * i;
      mass += b;
    }
    const pitch01 = mass > 1e-9 ? weighted / mass / 11 : v;
    return { energy: energy / 12, pitch01, bins };
  }

  /**
   * Visual retina: average RGBA over an overlapping UV tile of a website raster.
   * rgba = Uint8ClampedArray length w*h*4 (row-major).
   */
  function sampleVisualPatch(img, u, v, ru, rv) {
    if (!img || !img.rgba || !img.w || !img.h) {
      return { r: 0, g: 0, b: 0, a: 0, n: 0 };
    }
    const w = img.w;
    const h = img.h;
    const x0 = Math.max(0, Math.floor((u - ru) * w));
    const x1 = Math.min(w - 1, Math.ceil((u + ru) * w));
    const y0 = Math.max(0, Math.floor((v - rv) * h));
    const y1 = Math.min(h - 1, Math.ceil((v + rv) * h));
    const span = Math.max(1, x1 - x0 + 1) * Math.max(1, y1 - y0 + 1);
    const step = span > 400 ? 2 : 1;
    let r = 0,
      g = 0,
      b = 0,
      a = 0,
      n = 0;
    const rgba = img.rgba;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const i = (y * w + x) * 4;
        const aa = rgba[i + 3];
        if (aa < 8) continue;
        const wgt = aa / 255;
        r += rgba[i] * wgt;
        g += rgba[i + 1] * wgt;
        b += rgba[i + 2] * wgt;
        a += aa;
        n += wgt;
      }
    }
    if (n < 1e-6) return { r: 28, g: 38, b: 45, a: 0, n: 0 };
    return {
      r: Math.round(r / n),
      g: Math.round(g / n),
      b: Math.round(b / n),
      a: Math.round(a / Math.max(1, span / (step * step))),
      n,
    };
  }

  function createEyemapPanel(opts) {
    const { svgEl, selectEl, noteEl, legendEl } = opts;
    let data = null;
    let currentType = null;
    let layout = null;
    let streamActive = false;
    let chromaImage = null;
    let visualImage = null;
    let mode = "chroma";
    let polyEls = [];

    const COL_ANAT_LO = "#1c262d";
    const COL_ANAT_HI = "#5a3a2a";

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
      const spanX = Math.max(1e-6, maxX - minX);
      const spanY = Math.max(1e-6, maxY - minY);

      const n = laid.length;
      const tile = (0.5 / Math.sqrt(Math.max(1, n))) * OVERLAP;
      for (const c of laid) {
        c.u = (c.x - minX) / spanX;
        c.v = (c.y - minY) / spanY;
        c.ru = tile;
        c.rv = tile;
      }

      return {
        laid,
        size,
        pad,
        minX,
        minY,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
        maxV: Math.max(1, ...cols.map((c) => c.value)),
        n,
      };
    }

    function columnFill(c) {
      const anat = c.value / layout.maxV;
      const base = lerpColor(COL_ANAT_LO, COL_ANAT_HI, anat * 0.55);
      const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(base);
      const ar = m ? +m[1] : 28;
      const ag = m ? +m[2] : 38;
      const ab = m ? +m[3] : 45;

      if (!streamActive) return base;

      if (mode === "visual" && visualImage) {
        const s = sampleVisualPatch(visualImage, c.u, c.v, c.ru, c.rv);
        if (s.n < 1e-6) return base;
        const t = 0.92;
        return `rgb(${Math.round(ar + (s.r - ar) * t)},${Math.round(ag + (s.g - ag) * t)},${Math.round(ab + (s.b - ab) * t)})`;
      }

      if (!chromaImage) return base;

      const s = samplePatch(chromaImage, c.u, c.v, c.ru, c.rv);
      const intensity = Math.min(1, s.energy * 4.5);
      if (intensity < 0.02) return base;

      const [sr, sg, sb] = uvSpectrumRgb(s.pitch01, intensity);
      const t = 0.25 + 0.75 * intensity;
      return `rgb(${Math.round(ar + (sr - ar) * t)},${Math.round(ag + (sg - ag) * t)},${Math.round(ab + (sb - ab) * t)})`;
    }

    function paintLive() {
      if (!layout || !polyEls.length) return;
      for (let i = 0; i < polyEls.length; i++) {
        const c = layout.laid[i];
        const el = polyEls[i];
        if (!c || !el) continue;
        el.setAttribute("fill", columnFill(c));
        const title = el.querySelector("title");
        if (!title) continue;
        if (mode === "visual" && streamActive && visualImage) {
          const s = sampleVisualPatch(visualImage, c.u, c.v, c.ru, c.rv);
          title.textContent =
            `${currentType} · q=${c.q} r=${c.r} · uv ${c.u.toFixed(2)},${c.v.toFixed(2)} · anat ${c.value}` +
            ` · rgb(${s.r},${s.g},${s.b}) · patch n=${s.n.toFixed(0)}`;
        } else {
          const s =
            streamActive && chromaImage
              ? samplePatch(chromaImage, c.u, c.v, c.ru, c.rv)
              : null;
          title.textContent =
            `${currentType} · q=${c.q} r=${c.r} · uv ${c.u.toFixed(2)},${c.v.toFixed(2)} · anat ${c.value}` +
            (s
              ? ` · E ${s.energy.toFixed(3)} · ~${PITCH_NAMES[Math.round(s.pitch01 * 11)] || "?"}`
              : "");
        }
      }
    }

    function paintChroma() {
      paintLive();
    }

    function updateLegendNotes() {
      const entry =
        data && currentType && data.types[currentType] ? data.types[currentType] : null;
      if (legendEl) {
        if (mode === "visual") {
          legendEl.innerHTML = `
            <span><span class="swatch" style="background:#f0b429"></span><span class="swatch" style="background:#52c7e0"></span><span class="swatch" style="background:#4fdb9e"></span> site average RGB</span>
            <span style="color:var(--text-faint)">${
              entry ? entry.n_neurons + " neurons · " + entry.n_columns + " cols" : ""
            } · overlapping pixel tiles</span>`;
        } else {
          const swatches = [0, 0.25, 0.5, 0.75, 1]
            .map((t) => {
              const [r, g, b] = uvSpectrumRgb(t, 0.85);
              return `<span class="swatch" style="background:rgb(${r},${g},${b})"></span>`;
            })
            .join("");
          legendEl.innerHTML = `
            <span>${swatches} UV spectrum</span>
            <span style="color:var(--text-faint)">${
              entry ? entry.n_neurons + " neurons · " + entry.n_columns + " cols" : ""
            } · UV chromagram tiles</span>`;
        }
      }
      if (noteEl) {
        noteEl.textContent =
          mode === "visual"
            ? "Each hex is a retinal facet: overlapping pixel grid on the under-test page. Fill = average RGB of that spot."
            : "Each hex samples a UV patch of the playing chromagram (equal tiles + overlap). Color = UV spectrum by local pitch; brightness = energy. Follows the playhead.";
      }
    }

    function render() {
      if (!data || !currentType || !data.types[currentType]) {
        svgEl.innerHTML = "";
        layout = null;
        polyEls = [];
        return;
      }
      const entry = data.types[currentType];
      const cols = entry.columns || [];
      if (!cols.length) {
        layout = null;
        polyEls = [];
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

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "eyemap-cells");
      g.setAttribute("opacity", "0.92");
      polyEls = [];
      for (const c of layout.laid) {
        const cx = c.x - layout.minX + layout.pad;
        const cy = c.y - layout.minY + layout.pad;
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", hexPolygon(cx, cy, layout.size * 0.95));
        poly.setAttribute("stroke", cssVar("--hair", "#1c262d"));
        poly.setAttribute("stroke-width", "0.45");
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        poly.appendChild(title);
        poly.setAttribute("fill", columnFill(c));
        g.appendChild(poly);
        polyEls.push(poly);
      }
      svgEl.innerHTML = "";
      svgEl.appendChild(g);
      paintLive();
      updateLegendNotes();
    }

    function update(stateData) {
      if (stateData && stateData.visual_image) {
        setVisualImage(stateData.visual_image);
      } else if (stateData && stateData.chroma_image) {
        setChromaImage(stateData.chroma_image);
      } else if (stateData && stateData.chroma_fields) {
        setChromaFields(stateData.chroma_fields);
      }
    }

    function setChromaImage(img) {
      mode = "chroma";
      visualImage = null;
      if (!img || !img.data || !img.w) {
        chromaImage = null;
      } else {
        chromaImage = {
          w: img.w,
          h: img.h || 12,
          data: img.data,
        };
      }
      updateLegendNotes();
      if (streamActive) paintLive();
    }

    /**
     * Website raster for FX vision.
     * @param {{w:number,h:number,rgba:Uint8ClampedArray|number[]}} img
     */
    function setVisualImage(img) {
      mode = "visual";
      chromaImage = null;
      if (!img || !img.rgba || !img.w || !img.h) {
        visualImage = null;
      } else {
        visualImage = {
          w: img.w,
          h: img.h,
          rgba: img.rgba instanceof Uint8ClampedArray ? img.rgba : new Uint8ClampedArray(img.rgba),
        };
      }
      updateLegendNotes();
      if (streamActive) paintLive();
    }

    function setChromaFields(fields) {
      mode = "chroma";
      visualImage = null;
      const hear = fields && fields.hear;
      if (!hear) {
        chromaImage = null;
        updateLegendNotes();
        if (streamActive) paintLive();
        return;
      }
      const dataArr = new Float32Array(12);
      for (let i = 0; i < 12; i++) dataArr[i] = Number(hear[i]) || 0;
      const cols = [dataArr];
      if (fields.court) {
        const c = new Float32Array(12);
        for (let i = 0; i < 12; i++) c[i] = Number(fields.court[i]) || 0;
        cols.push(c);
      }
      if (fields.eye) {
        const e = new Float32Array(12);
        for (let i = 0; i < 12; i++) e[i] = Number(fields.eye[i]) || 0;
        cols.push(e);
      }
      const w = cols.length;
      const flat = new Float32Array(w * 12);
      for (let x = 0; x < w; x++) flat.set(cols[x], x * 12);
      setChromaImage({ w, h: 12, data: flat });
    }

    function setActive(on) {
      streamActive = !!on;
      paintLive();
    }

    function setMode(next) {
      mode = next === "visual" ? "visual" : "chroma";
      updateLegendNotes();
      paintLive();
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

    return {
      init,
      render,
      update,
      setActive,
      setMode,
      setChromaFields,
      setChromaImage,
      setVisualImage,
    };
  }

  global.FlyEyemap = { createEyemapPanel, axialToPixel, sampleVisualPatch };
})(window);
