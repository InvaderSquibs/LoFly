/**
 * Fly Console shell: load ExperienceReplay JSON, drive shared experience panels,
 * mount the selected activity adapter into #activitySlot.
 */
(function () {
  "use strict";

  // Each activity lives in activities/<id>/ with activity.js + experience.json.
  // Add a new folder + entry here when the fly learns a new task.
  const ACTIVITIES = {
    ttt: {
      data: "activities/ttt/experience.json",
      module: "activities/ttt/activity.js",
      label: "tic-tac-toe",
    },
    perception: {
      data: "activities/perception/experience.json",
      module: "activities/perception/activity.js",
      label: "odor perception",
    },
    lofly: {
      data: "activities/lofly/experience.json",
      module: "activities/lofly/activity.js",
      liveScoring: "activities/lofly/live_scoring.js",
      label: "LoFly (Bug DJ)",
    },
    fx: {
      data: "activities/fx/experience.json",
      module: "activities/fx/activity.js",
      label: "FX (form QA)",
    },
    "fs-avatar": {
      data: "activities/fs-avatar/experience.json",
      module: "activities/fs-avatar/activity.js",
      label: "FS-Avatar (snake)",
    },
  };

  function qsActivity() {
    const p = new URLSearchParams(location.search);
    const a = (p.get("activity") || "ttt").toLowerCase();
    return ACTIVITIES[a] ? a : "ttt";
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src + (src.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now();
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function main() {
    const activityId = qsActivity();
    const cfg = ACTIVITIES[activityId];

    // activity switcher links
    const switchEl = document.getElementById("activitySwitch");
    if (switchEl) {
      switchEl.innerHTML = Object.keys(ACTIVITIES)
        .map((id) => {
          const active = id === activityId ? " active" : "";
          return `<a class="${active}" href="?activity=${id}">${ACTIVITIES[id].label}</a>`;
        })
        .join("");
    }

    let replay;
    try {
      const res = await fetch(cfg.data);
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      replay = await res.json();
    } catch (err) {
      document.body.insertAdjacentHTML(
        "afterbegin",
        `<p style="color:#ef6a61;padding:16px;font-family:monospace">Failed to load ${cfg.data}: ${err.message}. Serve fly_console/ over HTTP (e.g. python3 -m http.server) so fetch works.</p>`
      );
      return;
    }

    if (cfg.liveScoring) {
      await loadScript(cfg.liveScoring);
    }
    await loadScript(cfg.module);
    const activity = window.FlyActivity;
    if (!activity) {
      console.error("Activity module did not register window.FlyActivity");
      return;
    }

    const meta = replay.meta || {};
    document.getElementById("brandTitle").textContent = meta.title || "Fly Brain Console";
      document.getElementById("brandSub").textContent =
      activityId === "lofly"
        ? "Live DJ set — random start, court while the song plays, brain activity streams with the audio."
        : activityId === "fx"
          ? "Live Gherkin QA — the fly perceives FlyMart’s DOM, then clicks / types / checks out."
          : activityId === "fs-avatar"
            ? "Live Battlesnake pilot — fly decides /move, shoves the joystick; gold snake is YOU."
            : meta.subtitle || "";
    document.getElementById("kicker").textContent =
      `MaleCNS v1.0 · ${meta.activity_id || activityId} · shared pathway evaluation`;

    const statRow = document.getElementById("statRow");
    const stats = meta.stats || [];
    if (activityId === "lofly") {
      const n = (meta.activity_payload && meta.activity_payload.catalogue_n) || "?";
      statRow.innerHTML = `
        <div class="stat"><div class="v">live</div><div class="l">mode</div></div>
        <div class="stat"><div class="v">${n}</div><div class="l">Library</div></div>
        <div class="stat win"><div class="v">ON</div><div class="l">Fly</div></div>`;
    } else {
      statRow.innerHTML = stats
        .map((s) => {
          const kind = s.kind ? ` ${s.kind}` : "";
          return `<div class="stat${kind}"><div class="v">${s.value}</div><div class="l">${s.label}</div></div>`;
        })
        .join("");
    }

    const learnPanel = document.getElementById("learnPanel");
    if (!replay.learning || activityId === "lofly" || activityId === "fx" || activityId === "fs-avatar") {
      learnPanel.querySelector(".sub").textContent =
        activityId === "lofly"
          ? "Live set — learning curve stays from the last offline export (optional)."
          : activityId === "fx"
            ? "Live FX run — learning curve comes later once scenarios accumulate pass/fail history."
            : activityId === "fs-avatar"
              ? "Live FS-Avatar — neuron wiring comes next from courtship / danger / food signals during play."
              : "This activity has no online learning series; pathway dynamics above are still the same evaluation.";
    }
    FlyExperience.renderLearning(
      document.getElementById("lcSvg"),
      document.getElementById("lcSummary"),
      activityId === "lofly" || activityId === "fx" || activityId === "fs-avatar" ? null : replay.learning
    );

    let skeletonPanel = null;
    let eyemapPanel = null;
    if (window.FlySkeleton3D && document.getElementById("skeletonMount")) {
      skeletonPanel = FlySkeleton3D.createSkeletonPanel({
        mount: document.getElementById("skeletonMount"),
        statusEl: document.getElementById("skeletonStatus"),
        dataUrl: "data/neuron_skeletons.json",
      });
      skeletonPanel.init().catch((err) => {
        const st = document.getElementById("skeletonStatus");
        if (st) st.textContent = "Failed to load skeletons: " + err.message;
        console.warn(err);
      });
    }
    if (window.FlyEyemap && document.getElementById("eyemapSvg")) {
      eyemapPanel = FlyEyemap.createEyemapPanel({
        svgEl: document.getElementById("eyemapSvg"),
        selectEl: document.getElementById("eyemapType"),
        noteEl: document.getElementById("eyemapNote"),
        legendEl: document.getElementById("eyemapLegend"),
        dataUrl: "data/optic_lobe_hexmap.json",
      });
      eyemapPanel.init().catch((err) => {
        const n = document.getElementById("eyemapNote");
        if (n) n.textContent = "Failed to load eyemap: " + err.message;
        console.warn(err);
      });
    }

    function driveAnatomy(stateData) {
      if (skeletonPanel && typeof skeletonPanel.update === "function") {
        skeletonPanel.update(stateData);
      }
      if (eyemapPanel && typeof eyemapPanel.update === "function") {
        eyemapPanel.update(stateData);
      }
    }

    const aboutEl = document.getElementById("aboutBody");
    if (activity.aboutHtml) {
      aboutEl.innerHTML = activity.aboutHtml(meta);
    }

    document.getElementById("footerLine").textContent =
      `fly_console / ${meta.activity_id || activityId} · MaleCNS v1.0 · ${
        typeof activity.startLive === "function" ? "live session" : "replay"
      }`;

    // —— Live activities (LoFly): no step replay ——
    if (typeof activity.startLive === "function") {
      await activity.startLive({
        slot: document.getElementById("activitySlot"),
        noteEl: document.getElementById("stepNote"),
        tabsEl: document.getElementById("episodeTabs"),
        dotsEl: document.getElementById("stepDots"),
        labelEl: document.getElementById("stepLabel"),
        prevBtn: document.getElementById("prevBtn"),
        nextBtn: document.getElementById("nextBtn"),
        cascadeSvg: document.getElementById("cascadeSvg"),
        rasterSvg: document.getElementById("rasterSvg"),
        legendEl: document.getElementById("cascadeLegend"),
        skeletonPanel,
        eyemapPanel,
        driveAnatomy,
        meta,
        replay,
      });
      return;
    }

    if (typeof activity.mount !== "function") {
      console.error("Activity module did not register window.FlyActivity.mount");
      return;
    }

    // —— Standard experience replay ——
    const tabsEl = document.getElementById("episodeTabs");
    let episodeIdx = 0;
    let step = 0;
    let streamRaf = 0;

    function episode() {
      return replay.episodes[episodeIdx];
    }

    function stateAt(si) {
      const id = episode().step_state_ids[si];
      return replay.states[id];
    }

    function stopTrialStream() {
      if (streamRaf) {
        cancelAnimationFrame(streamRaf);
        streamRaf = 0;
      }
    }

    /** Scrub rate_curves 0→1 so cascade/raster/skeletons animate through the trial. */
    function playTrialStream(stateData) {
      stopTrialStream();
      const tRun = (meta && meta.t_run_ms) || 150;
      // Stretch the simulated ms window into something watchable.
      const durationMs = Math.max(2200, Math.min(6000, tRun * 12));
      const t0 = performance.now();
      function frame(now) {
        const frac = Math.min(1, (now - t0) / durationMs);
        FlyExperience.setStreamProgress(frac);
        if (frac < 1) streamRaf = requestAnimationFrame(frame);
        else streamRaf = 0;
      }
      FlyExperience.setStreamProgress(0);
      driveAnatomy(stateData);
      streamRaf = requestAnimationFrame(frame);
    }

    function renderTabs() {
      tabsEl.innerHTML = "";
      replay.episodes.forEach((ep, i) => {
        const btn = document.createElement("button");
        btn.className = "tab" + (i === episodeIdx ? " active" : "");
        btn.setAttribute("role", "tab");
        const label =
          (activity.episodeTabLabel && activity.episodeTabLabel(ep, meta)) ||
          ep.note ||
          ep.id;
        btn.textContent = label;
        btn.addEventListener("click", () => {
          episodeIdx = i;
          step = 0;
          renderTabs();
          renderAll();
        });
        tabsEl.appendChild(btn);
      });
    }

    function renderAll() {
      const ep = episode();
      const keys = ep.step_state_ids;
      step = Math.max(0, Math.min(step, keys.length - 1));
      const stateData = stateAt(step);

      FlyExperience.setStreamContext({
        cascadeSvg: document.getElementById("cascadeSvg"),
        rasterSvg: document.getElementById("rasterSvg"),
        legendEl: document.getElementById("cascadeLegend"),
        stateData,
        meta,
        streamFrac: 0,
        onProgress: (frac, sliced) => {
          driveAnatomy(sliced || stateData);
        },
      });

      FlyExperience.renderStepControls({
        step,
        nSteps: keys.length,
        dotsEl: document.getElementById("stepDots"),
        labelEl: document.getElementById("stepLabel"),
        prevBtn: document.getElementById("prevBtn"),
        nextBtn: document.getElementById("nextBtn"),
        onSelect: (i) => {
          step = i;
          renderAll();
        },
      });

      activity.mount({
        slot: document.getElementById("activitySlot"),
        noteEl: document.getElementById("stepNote"),
        replay,
        meta,
        episode: ep,
        step,
        stateId: keys[step],
        stateData,
        syncBrainStream: (frac) => FlyExperience.setStreamProgress(frac),
      });

      playTrialStream(stateData);
    }

    document.getElementById("prevBtn").addEventListener("click", () => {
      step = Math.max(0, step - 1);
      renderAll();
    });
    document.getElementById("nextBtn").addEventListener("click", () => {
      step = Math.min(episode().step_state_ids.length - 1, step + 1);
      renderAll();
    });

    renderTabs();
    renderAll();
  }

  main();
})();
