/**
 * Real MaleCNS SWC skeletons (decimated) — Three.js panel.
 * Continuously animated from activity pathway feeds (rate_curves / stage rates):
 * traveling fade-along-curve + stage brightness, including LoFly live samples.
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
    if (group.startsWith("cell_")) return "ALPN";
    if (group.startsWith("move_")) return "DAN";
    return null;
  }

  function loadThree() {
    if (global.THREE) return Promise.resolve(global.THREE);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
      s.onload = () => resolve(global.THREE);
      s.onerror = () => reject(new Error("Failed to load Three.js"));
      document.head.appendChild(s);
    });
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

  function stageRateNow(stateData, stage) {
    if (!stateData || !stage) return 0;
    if (global.FlyExperience && global.FlyExperience.stageMeanRate) {
      // Prefer instantaneous keys when present (live / stream-scrubbed snapshots).
      const key = {
        ALPN: "alpn_rate",
        Kenyon_Cell: "kc_rate",
        MBON: "mbon_rate",
        DAN: "dan_rate",
      }[stage];
      if (key && stateData[key] != null) return Number(stateData[key]) || 0;
      return global.FlyExperience.stageMeanRate(stateData, stage);
    }
    const key = {
      ALPN: "alpn_rate",
      Kenyon_Cell: "kc_rate",
      MBON: "mbon_rate",
      DAN: "dan_rate",
    }[stage];
    return key ? Number(stateData[key] || 0) : 0;
  }

  /** Map Hz → 0..1. Quiet stages collapse toward 0 so traces go see-through. */
  function rateToBoost(hz, refMax) {
    const ref = Math.max(40, refMax || 160);
    const n = Math.max(0, Number(hz) || 0) / ref;
    if (n < 0.1) return n * 0.12; // <10% of peak → essentially invisible
    return Math.min(1, Math.pow((n - 0.05) / 0.95, 0.9));
  }

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
      colors[i * 3] = r * 0.02;
      colors[i * 3 + 1] = g * 0.02;
      colors[i * 3 + 2] = b * 0.02;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.02,
      depthWrite: false,
    });
    mat.userData = { baseRgb: [r, g, b], fadePhase };
    return new THREE.Line(geo, mat);
  }

  /**
   * Write traveling-wave vertex colors. Called at ~15 Hz, not every frame.
   * wavePos is 0..1 head of the pulse along the polyline.
   */
  function paintWave(line, boost, wavePos) {
    const geo = line.geometry;
    const colors = geo.attributes.color;
    const n = geo.attributes.position.count;
    const base = line.material.userData.baseRgb || [1, 1, 1];
    const phase = line.material.userData.fadePhase || 0;
    // Quiet axons stay near black; only active boost lights the wave.
    const gate = boost * boost;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      const dist = Math.abs(t - wavePos);
      const wrap = Math.min(dist, 1 - dist);
      const packet = Math.exp(-wrap * wrap * 28);
      const shimmer = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4 + phase));
      const fade = (0.08 + 0.92 * packet) * shimmer;
      const v = fade * gate;
      colors.setXYZ(i, base[0] * v, base[1] * v, base[2] * v);
    }
    colors.needsUpdate = true;
  }

  function createSkeletonPanel(opts) {
    const mount = opts.mount;
    const statusEl = opts.statusEl;
    let THREE, renderer, scene, camera, lines = [], animId = 0;
    let disposed = false;
    let ready = false;
    let pendingState = null;
    let latestState = null;
    let stageBoost = { ALPN: 0, Kenyon_Cell: 0, MBON: 0, DAN: 0, other: 0 };
    let lastPaint = 0;
    let paintCursor = 0;
    let streamActive = false;
    let resolveReady;
    const readyPromise = new Promise((r) => {
      resolveReady = r;
    });

    function setStatus(msg) {
      if (statusEl) statusEl.textContent = msg;
    }

    let controls = null;
    let dragging = false;
    let lastX = 0,
      lastY = 0;
    let pivot = null;

    function fitCamera(box) {
      if (!box || box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      camera.position.set(
        center.x + maxDim * 0.9,
        center.y + maxDim * 0.55,
        center.z + maxDim * 0.9
      );
      camera.near = maxDim / 200;
      camera.far = maxDim * 20;
      camera.updateProjectionMatrix();
      camera.lookAt(center);
      if (controls) {
        controls.target.copy(center);
        controls.update();
      }
    }

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
          offset.multiplyScalar(e.deltaY > 0 ? 1.08 : 0.92);
          camera.position.copy(pivot).add(offset);
          camera.lookAt(pivot);
        },
        { passive: false }
      );
      controls = { target: null, update() {} };
    }

    function applyState(stateData) {
      latestState = stateData || null;
      if (!stateData) return;
      const rates = {
        ALPN: stageRateNow(stateData, "ALPN"),
        Kenyon_Cell: stageRateNow(stateData, "Kenyon_Cell"),
        MBON: stageRateNow(stateData, "MBON"),
        DAN: stageRateNow(stateData, "DAN"),
      };
      const refMax = Math.max(80, rates.ALPN, rates.Kenyon_Cell, rates.MBON, rates.DAN, 1);
      stageBoost = {
        ALPN: rateToBoost(rates.ALPN, refMax),
        Kenyon_Cell: rateToBoost(rates.Kenyon_Cell, refMax),
        MBON: rateToBoost(rates.MBON, refMax),
        DAN: rateToBoost(rates.DAN, refMax),
        other: 0,
      };
    }

    async function init() {
      setStatus("Loading Three.js…");
      THREE = await loadThree();
      setStatus("Loading skeletons…");
      const res = await fetch(opts.dataUrl || "data/neuron_skeletons.json");
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      const skeletons = await res.json();
      const ids = Object.keys(skeletons);

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
          line.userData = {
            bodyId: bid,
            stage: stage || "other",
            group: entry.group,
            speed: 0.35 + ((parseInt(bid, 10) + pi * 17) % 50) / 80,
          };
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
        `${nNeurons} neurons · live pathway drive · drag to orbit · scroll to zoom`
      );

      ready = true;
      if (pendingState) {
        applyState(pendingState);
        pendingState = null;
      }
      resolveReady && resolveReady();

      function tick(now) {
        if (disposed) return;
        animId = requestAnimationFrame(tick);
        const t = now * 0.001;

        for (const line of lines) {
          const st = line.userData.stage || "other";
          const boost = stageBoost[st] != null ? stageBoost[st] : stageBoost.other;
          if (boost < 0.04) {
            line.material.opacity = 0.012 * Math.max(boost, 0.15);
            line.visible = boost > 0.008;
            continue;
          }
          line.visible = true;
          if (streamActive) {
            const breath =
              0.78 +
              0.22 *
                Math.sin(
                  t * (1.2 + boost * 3.5) + (line.material.userData.fadePhase || 0)
                );
            line.material.opacity = Math.min(1, Math.pow(boost, 1.35) * breath);
          } else {
            // Frozen at last pathway rates — no autonomous shimmer when paused
            line.material.opacity = Math.min(1, Math.pow(boost, 1.35) * 0.85);
          }
        }

        if (streamActive && now - lastPaint > 80) {
          lastPaint = now;
          const batch = 400;
          const start = (paintCursor || 0) % Math.max(1, lines.length);
          for (let i = start; i < Math.min(lines.length, start + batch); i++) {
            const line = lines[i];
            const st = line.userData.stage || "other";
            const boost = stageBoost[st] != null ? stageBoost[st] : stageBoost.other;
            const speed = line.userData.speed || 0.5;
            const wavePos =
              (t * speed * (0.4 + boost * 1.6) + (line.material.userData.fadePhase || 0)) %
              1;
            paintWave(line, boost, wavePos);
          }
          paintCursor = start + batch;
          if (paintCursor >= lines.length) paintCursor = 0;
        }

        renderer.render(scene, camera);
      }
      requestAnimationFrame(tick);

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
      if (!ready) {
        pendingState = stateData;
        return;
      }
      applyState(stateData);
    }

    function setActive(on) {
      streamActive = !!on;
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

    return { init, update, setActive, destroy, ready: readyPromise };
  }

  global.FlySkeleton3D = {
    createSkeletonPanel,
  };
})(window);
