/**
 * Real MaleCNS SWC skeletons (decimated) — Three.js panel.
 * Brightness driven by stage mean rates from experience stateData;
 * per-vertex alpha fades along each polyline (jittered fade-along-curve).
 */
(function (global) {
  "use strict";

  const STAGE_OF_GROUP = {
    ALPN: "ALPN",
    Kenyon_Cell: "Kenyon_Cell",
    MBON: "MBON",
    DAN: "DAN",
  };

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function stageForGroup(group) {
    if (!group) return null;
    if (STAGE_OF_GROUP[group]) return STAGE_OF_GROUP[group];
    if (group.startsWith("cell_")) return "ALPN"; // ORN hubs → treat near AL input
    if (group.startsWith("move_")) return "DAN"; // descending readout neighborhood
    return null;
  }

  function loadThree() {
    if (global.THREE) return Promise.resolve(global.THREE);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      // Pin a stable r128 build (common CDN pattern for this project era).
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
      s.onload = () => resolve(global.THREE);
      s.onerror = () => reject(new Error("Failed to load Three.js"));
      document.head.appendChild(s);
    });
  }

  /**
   * Build Line geometry with per-vertex RGB. Alpha-fade is encoded as
   * brightness falloff along the curve (jittered phase), matching the prior
   * visualizer's fade-along-curve intent without a custom shader.
   */
  function buildLine(THREE, points, colorHex, fadePhase) {
    const n = points.length;
    if (n < 2) return null;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const [r, g, b] = hexToRgb(colorHex).map((c) => c / 255);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
      const t = i / (n - 1);
      const wave = 0.55 + 0.45 * Math.sin((t * Math.PI * 2 + fadePhase) % (Math.PI * 2));
      const fade = Math.max(0.12, (1 - t * 0.7) * wave);
      colors[i * 3] = r * fade;
      colors[i * 3 + 1] = g * fade;
      colors[i * 3 + 2] = b * fade;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    mat.userData = { baseRgb: [r, g, b], fadePhase };
    return new THREE.Line(geo, mat);
  }

  /** Update per-vertex fade + firing-state brightness. */
  function updateEdgeAlpha(line, brightness) {
    const geo = line.geometry;
    const colors = geo.attributes.color;
    const n = geo.attributes.position.count;
    const phase = (line.material.userData && line.material.userData.fadePhase) || 0;
    const base = (line.material.userData && line.material.userData.baseRgb) || [1, 1, 1];
    const boost = 0.22 + 0.78 * Math.max(0, Math.min(1, brightness));
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      const wave = 0.55 + 0.45 * Math.sin((t * Math.PI * 2 + phase) % (Math.PI * 2));
      const fade = Math.max(0.1, (1 - t * 0.7) * wave) * boost;
      colors.setXYZ(i, base[0] * fade, base[1] * fade, base[2] * fade);
    }
    colors.needsUpdate = true;
    line.material.opacity = 0.35 + 0.6 * boost;
  }

  function stageColor(stage) {
    const map = {
      ALPN: "--cyan",
      Kenyon_Cell: "--violet",
      MBON: "--amber",
      DAN: "--green",
    };
    return cssVar(map[stage] || "--text-faint", "#8496a1");
  }

  function stageBrightness(stateData, stage) {
    if (!stateData || !stage) return 0.15;
    const meanFn =
      global.FlyExperience && global.FlyExperience.stageMeanRate
        ? global.FlyExperience.stageMeanRate
        : null;
    let hz = 0;
    if (meanFn) hz = meanFn(stateData, stage);
    else {
      const key = { ALPN: "alpn_rate", Kenyon_Cell: "kc_rate", MBON: "mbon_rate", DAN: "dan_rate" }[
        stage
      ];
      hz = key ? Number(stateData[key] || 0) : 0;
    }
    // Soft normalize against typical cascade rates (~0–200 Hz).
    return Math.max(0.08, Math.min(1, hz / 160));
  }

  function createSkeletonPanel(opts) {
    const mount = opts.mount;
    const statusEl = opts.statusEl;
    let THREE, renderer, scene, camera, lines = [], animId = 0;
    let skeletons = null;
    let disposed = false;

    function setStatus(msg) {
      if (statusEl) statusEl.textContent = msg;
    }

    function fitCamera(box) {
      if (!box || box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      camera.position.set(center.x + maxDim * 0.9, center.y + maxDim * 0.55, center.z + maxDim * 0.9);
      camera.near = maxDim / 200;
      camera.far = maxDim * 20;
      camera.updateProjectionMatrix();
      camera.lookAt(center);
      if (controls) {
        controls.target.copy(center);
        controls.update();
      }
    }

    let controls = null;
    let dragging = false;
    let lastX = 0, lastY = 0;
    let pivot = null;

    function attachOrbit(el) {
      el.addEventListener("pointerdown", (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener("pointerup", () => {
        dragging = false;
      });
      el.addEventListener("pointermove", (e) => {
        if (!dragging || !camera || !pivot) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        const offset = camera.position.clone().sub(pivot);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta -= dx * 0.005;
        spherical.phi += dy * 0.005;
        spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi));
        offset.setFromSpherical(spherical);
        camera.position.copy(pivot).add(offset);
        camera.lookAt(pivot);
      });
      el.addEventListener(
        "wheel",
        (e) => {
          if (!camera || !pivot) return;
          e.preventDefault();
          const offset = camera.position.clone().sub(pivot);
          const factor = e.deltaY > 0 ? 1.08 : 0.92;
          offset.multiplyScalar(factor);
          camera.position.copy(pivot).add(offset);
          camera.lookAt(pivot);
        },
        { passive: false }
      );
      controls = { target: null, update() {} };
    }

    async function init() {
      setStatus("Loading Three.js…");
      THREE = await loadThree();
      setStatus("Loading skeletons…");
      const res = await fetch(opts.dataUrl || "data/neuron_skeletons.json");
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      skeletons = await res.json();
      const ids = Object.keys(skeletons);
      setStatus(`${ids.length} skeletons`);

      const w = mount.clientWidth || 640;
      const h = Math.max(280, Math.min(420, Math.round(w * 0.45)));
      mount.style.height = h + "px";
      mount.innerHTML = "";

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(42, w / h, 1, 1e7);
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(w, h, false);
      renderer.setClearColor(0x000000, 0);
      mount.appendChild(renderer.domElement);
      attachOrbit(renderer.domElement);

      const box = new THREE.Box3();
      for (const bid of ids) {
        const entry = skeletons[bid];
        const polys =
          entry.polylines && entry.polylines.length
            ? entry.polylines
            : entry.points && entry.points.length >= 2
              ? [entry.points]
              : [];
        if (!polys.length) continue;
        const stage = stageForGroup(entry.group);
        const color = stage ? stageColor(stage) : cssVar("--text-faint", "#526069");
        const phase = (parseInt(bid, 10) % 997) * 0.01;
        for (let pi = 0; pi < polys.length; pi++) {
          const pts = polys[pi];
          if (!pts || pts.length < 2) continue;
          const line = buildLine(THREE, pts, color, phase + pi * 0.37);
          if (!line) continue;
          line.userData = { bodyId: bid, stage: stage || "other", group: entry.group };
          scene.add(line);
          lines.push(line);
          box.expandByObject(line);
        }
      }
      pivot = box.getCenter(new THREE.Vector3());
      controls.target = pivot.clone();
      fitCamera(box);
      const nNeurons = new Set(lines.map((l) => l.userData.bodyId)).size;
      setStatus(
        `${nNeurons} neurons · ${lines.length} traces · drag to orbit · scroll to zoom`
      );

      function tick() {
        if (disposed) return;
        animId = requestAnimationFrame(tick);
        renderer.render(scene, camera);
      }
      tick();

      const ro = new ResizeObserver(() => {
        if (!renderer || !camera) return;
        const nw = mount.clientWidth || w;
        const nh = Math.max(280, Math.min(420, Math.round(nw * 0.45)));
        mount.style.height = nh + "px";
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh, false);
      });
      ro.observe(mount);
    }

    function update(stateData) {
      if (!lines.length) return;
      const bright = {
        ALPN: stageBrightness(stateData, "ALPN"),
        Kenyon_Cell: stageBrightness(stateData, "Kenyon_Cell"),
        MBON: stageBrightness(stateData, "MBON"),
        DAN: stageBrightness(stateData, "DAN"),
        other: 0.12,
      };
      for (const line of lines) {
        const st = line.userData.stage || "other";
        updateEdgeAlpha(line, bright[st] != null ? bright[st] : bright.other);
      }
    }

    function destroy() {
      disposed = true;
      cancelAnimationFrame(animId);
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
      lines = [];
    }

    return { init, update, destroy };
  }

  global.FlySkeleton3D = {
    createSkeletonPanel,
    updateEdgeAlpha,
  };
})(window);
