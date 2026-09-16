/**
 * FX vision — rasterize the under-test page so optic-lobe hexes can sample
 * average RGB from overlapping pixel tiles (retinal facets).
 */
(function (global) {
  "use strict";

  const H2C_URL =
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src.indexOf("html2canvas") !== -1) && global.html2canvas) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function ensureHtml2Canvas() {
    if (typeof global.html2canvas === "function") return;
    await loadScript(H2C_URL);
    if (typeof global.html2canvas !== "function") {
      throw new Error("html2canvas unavailable");
    }
  }

  /**
   * Fallback painter when CDN is blocked: approximate the site from layout boxes.
   * Still produces a real pixel grid for hex averaging.
   */
  function paintStructural(el, scale) {
    const rect = el.getBoundingClientRect();
    const w = Math.max(8, Math.round(rect.width * scale));
    const h = Math.max(8, Math.round(rect.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f7f5f1";
    ctx.fillRect(0, 0, w, h);

    const rootRect = rect;
    const nodes = el.querySelectorAll("*");
    nodes.forEach((node) => {
      if (node.closest && node.closest(".fx-fly")) return;
      const st = window.getComputedStyle(node);
      if (st.display === "none" || st.visibility === "hidden") return;
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const bg = st.backgroundColor;
      if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return;
      const x = ((r.left - rootRect.left) / rootRect.width) * w;
      const y = ((r.top - rootRect.top) / rootRect.height) * h;
      const rw = (r.width / rootRect.width) * w;
      const rh = (r.height / rootRect.height) * h;
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, Math.max(1, rw), Math.max(1, rh));
    });

    // Text ink as dark flecks so product titles leave a signal
    el.querySelectorAll("h1, h2, button, .fx-site-brand, label").forEach((node) => {
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const x = ((r.left - rootRect.left) / rootRect.width) * w;
      const y = ((r.top - rootRect.top) / rootRect.height) * h;
      const rw = (r.width / rootRect.width) * w;
      const rh = (r.height / rootRect.height) * h;
      const color = window.getComputedStyle(node).color || "#1c1916";
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, y + rh * 0.35, Math.max(1, rw), Math.max(1, rh * 0.35));
      ctx.globalAlpha = 1;
    });

    const img = ctx.getImageData(0, 0, w, h);
    return { w, h, rgba: img.data, source: "structural" };
  }

  /**
   * @param {HTMLElement} el
   * @param {{scale?: number}} opts
   * @returns {Promise<{w:number,h:number,rgba:Uint8ClampedArray,source:string}>}
   */
  async function capture(el, opts) {
    opts = opts || {};
    const scale = opts.scale != null ? opts.scale : 0.45;
    if (!el) throw new Error("no element to capture");

    try {
      await ensureHtml2Canvas();
      const canvas = await global.html2canvas(el, {
        scale: scale,
        logging: false,
        backgroundColor: "#f7f5f1",
        useCORS: true,
        allowTaint: true,
        imageTimeout: 2000,
      });
      const ctx = canvas.getContext("2d");
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { w: canvas.width, h: canvas.height, rgba: img.data, source: "html2canvas" };
    } catch (err) {
      console.warn("FX vision html2canvas failed, using structural painter", err);
      return paintStructural(el, scale);
    }
  }

  global.FxVision = { capture, paintStructural };
})(window);
