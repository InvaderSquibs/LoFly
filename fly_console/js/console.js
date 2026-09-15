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
      label: "LoFly (Bug DJ)",
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
      s.src = src;
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

    await loadScript(cfg.module);
    const activity = window.FlyActivity;
    if (!activity || typeof activity.mount !== "function") {
      console.error("Activity module did not register window.FlyActivity.mount");
      return;
    }

    const meta = replay.meta;
    document.getElementById("brandTitle").textContent = meta.title || "Fly Brain Console";
    document.getElementById("brandSub").textContent = meta.subtitle || "";
    document.getElementById("kicker").textContent =
      `MaleCNS v1.0 · ${meta.activity_id || activityId} · shared pathway evaluation`;

    // header stats
    const statRow = document.getElementById("statRow");
    const stats = meta.stats || [];
    statRow.innerHTML = stats
      .map((s) => {
        const kind = s.kind ? ` ${s.kind}` : "";
        return `<div class="stat${kind}"><div class="v">${s.value}</div><div class="l">${s.label}</div></div>`;
      })
      .join("");

    // learning panel visibility
    const learnPanel = document.getElementById("learnPanel");
    if (!replay.learning) {
      learnPanel.querySelector(".sub").textContent =
        "This activity has no online learning series; pathway dynamics above are still the same evaluation.";
    }
    FlyExperience.renderLearning(
      document.getElementById("lcSvg"),
      document.getElementById("lcSummary"),
      replay.learning
    );

    // Shared anatomy panels (console-level, not activity-specific).
    let skeletonPanel = null;
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
      const eyemap = FlyEyemap.createEyemapPanel({
        svgEl: document.getElementById("eyemapSvg"),
        selectEl: document.getElementById("eyemapType"),
        noteEl: document.getElementById("eyemapNote"),
        legendEl: document.getElementById("eyemapLegend"),
        dataUrl: "data/optic_lobe_hexmap.json",
      });
      eyemap.init().catch((err) => {
        const n = document.getElementById("eyemapNote");
        if (n) n.textContent = "Failed to load eyemap: " + err.message;
        console.warn(err);
      });
    }

    // episode tabs
    const tabsEl = document.getElementById("episodeTabs");
    let episodeIdx = 0;
    let step = 0;

    function episode() {
      return replay.episodes[episodeIdx];
    }

    function stateAt(si) {
      const id = episode().step_state_ids[si];
      return replay.states[id];
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

      FlyExperience.renderCascade(
        document.getElementById("cascadeSvg"),
        document.getElementById("cascadeLegend"),
        stateData,
        meta
      );
      FlyExperience.renderRaster(
        document.getElementById("rasterSvg"),
        stateData,
        meta
      );

      if (skeletonPanel && typeof skeletonPanel.update === "function") {
        skeletonPanel.update(stateData);
      }

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
      });
    }

    document.getElementById("prevBtn").addEventListener("click", () => {
      step = Math.max(0, step - 1);
      renderAll();
    });
    document.getElementById("nextBtn").addEventListener("click", () => {
      step = Math.min(episode().step_state_ids.length - 1, step + 1);
      renderAll();
    });

    // about blurb — activity may customize
    const aboutEl = document.getElementById("aboutBody");
    if (activity.aboutHtml) {
      aboutEl.innerHTML = activity.aboutHtml(meta);
    }

    document.getElementById("footerLine").textContent =
      `fly_console / ${meta.activity_id} · MaleCNS v1.0 · shared ALPN→KC→MBON→DAN evaluation`;

    renderTabs();
    renderAll();
  }

  main();
})();
