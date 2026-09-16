/**
 * FX (Fly Experience) — Gherkin runner with live DOM perception.
 *
 * Perception: FxPerceive reads the under-test page's live HTML tree (what Vue
 * would leave after render) and finds the best element for a quoted label.
 * Action: the fly moves there and clicks / types / selects / asserts.
 */
(function (global) {
  "use strict";

  const FX_BASE = "activities/fx/";
  const FEATURE_URL = FX_BASE + "features/flymart_checkout.feature";
  const FLY_GIF = FX_BASE + "assets/fly_topdown.gif?v=3";
  const FLY_SIZE = 56;
  const N_BINS = 50;

  let live = null;
  let runToken = 0;
  let flyPose = { x: 12, y: 12, angle: 0 };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src + (src.indexOf("?") >= 0 ? "&" : "?") + "v=nn1";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  function emptyCurves() {
    const z = () => Array(N_BINS).fill(0);
    return { ALPN: z(), Kenyon_Cell: z(), MBON: z(), DAN: z() };
  }

  function emptyRaster() {
    return { ALPN: [], Kenyon_Cell: [], MBON: [], DAN: [] };
  }

  function synthState(frac, passed, looking, matchQ) {
    const f = Math.max(0, Math.min(1, frac));
    const q = matchQ != null ? Math.max(0, Math.min(1, matchQ)) : looking ? 0.35 : 0;
    const curves = emptyCurves();
    for (let i = 0; i < N_BINS; i++) {
      const t = i / (N_BINS - 1);
      const gate = t <= f ? 1 : 0.08;
      // Search: ALPN floods early; KC peaks mid-glance; MBON/DAN rise with match quality.
      const lookBoost = looking ? 1.55 + 0.9 * q : 1;
      curves.ALPN[i] =
        (22 + 70 * Math.sin(t * Math.PI) * (looking ? 1.4 : 1)) * gate * lookBoost;
      curves.Kenyon_Cell[i] =
        (14 + 85 * Math.sin(t * Math.PI * 1.15 + 0.15) * (0.55 + 0.7 * q)) *
        gate *
        (looking ? 1.35 : 1);
      curves.MBON[i] =
        (10 + 60 * Math.sin(t * Math.PI * 0.95 + 0.35) * (0.3 + 0.9 * q)) * gate;
      curves.DAN[i] =
        (8 +
          (passed ? 70 : 18 + 55 * q) * Math.sin(t * Math.PI * 0.75 + 0.25)) *
        gate;
    }
    const idx = Math.min(N_BINS - 1, Math.floor(f * (N_BINS - 1)));
    return {
      rate_curves: curves,
      raster: emptyRaster(),
      alpn_rate: curves.ALPN[idx],
      kc_rate: curves.Kenyon_Cell[idx],
      mbon_rate: curves.MBON[idx],
      dan_rate: curves.DAN[idx],
    };
  }

  function pushBrain(hooks, frac, passed, looking, matchQ) {
    const state = synthState(frac, passed, looking, matchQ);
    if (hooks.cascadeSvg) {
      global.FlyExperience.setStreamContext({
        cascadeSvg: hooks.cascadeSvg,
        rasterSvg: hooks.rasterSvg,
        legendEl: hooks.legendEl,
        stateData: state,
        meta: hooks.meta,
        streamFrac: frac,
        onProgress: (pf, sliced) => {
          if (hooks.driveAnatomy) hooks.driveAnatomy(sliced || state);
        },
      });
      global.FlyExperience.setStreamProgress(frac);
    }
    if (hooks.driveAnatomy) hooks.driveAnatomy(state);
    return state;
  }

  /** Scrub pathway during a single glance evaluation (ALPN→KC→MBON/DAN). */
  async function neuralGlance(matchScore) {
    if (!live || !live.hooks) return;
    const q = global.FxPerceive.matchQuality(matchScore);
    const frames = 7;
    for (let i = 0; i <= frames; i++) {
      const t = i / frames;
      pushBrain(live.hooks, t, false, true, q);
      await sleep(38 + Math.round(22 * (1 - q))); // hard rejects linger a bit longer
    }
  }

  let visionBusy = false;
  let visionTimer = 0;

  function eyemapPanel() {
    return live && live.hooks && live.hooks.eyemapPanel;
  }

  function enableVisualEyes() {
    const panel = eyemapPanel();
    if (!panel) return;
    if (typeof panel.setMode === "function") panel.setMode("visual");
    if (typeof panel.setActive === "function") panel.setActive(true);
  }

  /** Snapshot #fxSite into overlapping hex retina tiles. */
  async function pushSiteVision() {
    const panel = eyemapPanel();
    const site = siteRoot();
    if (!panel || !site || !global.FxVision || visionBusy) return;
    visionBusy = true;
    try {
      const img = await global.FxVision.capture(site, { scale: 0.4 });
      if (typeof panel.setVisualImage === "function") {
        panel.setVisualImage(img);
      } else if (typeof panel.update === "function") {
        panel.update({ visual_image: img });
      }
      if (typeof panel.setActive === "function") panel.setActive(true);
    } catch (err) {
      console.warn("FX vision", err);
    } finally {
      visionBusy = false;
    }
  }

  function startVisionLoop() {
    stopVisionLoop();
    enableVisualEyes();
    pushSiteVision();
    visionTimer = window.setInterval(() => {
      pushSiteVision();
    }, 900);
  }

  function stopVisionLoop() {
    if (visionTimer) {
      clearInterval(visionTimer);
      visionTimer = 0;
    }
  }

  function parseGherkin(text) {
    const lines = text.split(/\r?\n/);
    let feature = "";
    let scenario = "";
    const steps = [];
    for (const raw of lines) {
      const line = raw.replace(/^\s*#.*/, "").trim();
      if (!line) continue;
      const feat = line.match(/^Feature:\s*(.+)$/i);
      if (feat) {
        feature = feat[1].trim();
        continue;
      }
      const scen = line.match(/^Scenario:\s*(.+)$/i);
      if (scen) {
        scenario = scen[1].trim();
        continue;
      }
      const step = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
      if (step) {
        steps.push({ keyword: step[1], text: step[2].trim(), raw: line });
      }
    }
    return { feature, scenario, steps };
  }

  function chromeHtml() {
    return `
      <div class="fx-chrome fx-chrome-mart">
        <div class="fx-stage" id="fxStage">
          <div class="fx-fly" id="fxFly" aria-hidden="true">
            <img class="fx-fly-img" src="${FLY_GIF}" width="${FLY_SIZE}" height="${FLY_SIZE}" alt=""/>
          </div>
          <div class="fx-site-host" id="fxSiteHost"></div>
        </div>
        <div class="fx-side">
          <div class="fx-toolbar">
            <button type="button" class="fx-run" id="fxRun">▶ Run scenario</button>
            <span class="mono fx-status" id="fxStatus">idle</span>
          </div>
          <div class="fx-perceive mono" id="fxPerceive">perception: idle</div>
          <div class="fx-feature-wrap">
            <div class="cap">gherkin · flymart_checkout.feature</div>
            <pre class="fx-feature mono" id="fxFeature"></pre>
          </div>
          <div class="fx-log-wrap">
            <div class="cap">step log</div>
            <ol class="fx-log mono" id="fxLog"></ol>
          </div>
        </div>
      </div>`;
  }

  function ensureChrome(slot) {
    slot.innerHTML = chromeHtml();
    slot.dataset.fxReady = "1";
    delete slot.dataset.tttReady;
    delete slot.dataset.percReady;
    flyPose = { x: 12, y: 12, angle: 0 };
    const fly = flyEl();
    if (fly) applyFlyPose(fly, flyPose.x, flyPose.y, flyPose.angle);
  }

  function siteRoot() {
    return document.getElementById("fxSite");
  }

  function flyEl() {
    return document.getElementById("fxFly");
  }

  function stageEl() {
    return document.getElementById("fxStage");
  }

  function setFlyVisible(on) {
    const fly = flyEl();
    if (!fly) return;
    fly.classList.toggle("visible", !!on);
  }

  function applyFlyPose(fly, x, y, angle) {
    flyPose = { x, y, angle };
    fly.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg)`;
  }

  function flyTo(el, mode) {
    const fly = flyEl();
    const stage = stageEl();
    if (!fly || !stage) return sleep(0);
    const target =
      el && el.nodeType === 1 && el.isConnected
        ? el
        : document.getElementById("fxSite") || stage;
    try {
      const s = stage.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const x = r.left - s.left + Math.max(r.width, 4) / 2 - FLY_SIZE / 2;
      const y = r.top - s.top + Math.min(Math.max(r.height, 4) / 2, 48) - FLY_SIZE / 2;
      const dx = x - flyPose.x;
      const dy = y - flyPose.y;
      let angle = flyPose.angle;
      if (Math.hypot(dx, dy) > 6) {
        angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
      }
      applyFlyPose(fly, x, y, angle);
    } catch (err) {
      console.warn("FX flyTo pose failed", err);
    }
    fly.classList.toggle("clicking", mode === "click");
    fly.classList.toggle("looking", mode === "look" || mode === "hover");
    setFlyVisible(true);
    return sleep(mode === "click" ? 220 : 300);
  }

  function setPerceive(msg) {
    const el = document.getElementById("fxPerceive");
    if (el) el.textContent = "perception: " + msg;
  }

  function logStep(text, status) {
    const log = document.getElementById("fxLog");
    if (!log) return;
    const li = document.createElement("li");
    li.className = "fx-log-item " + status;
    li.textContent = text;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(msg) {
    const el = document.getElementById("fxStatus");
    if (el) el.textContent = msg;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function highlightFeatureLine(stepIndex) {
    const pre = document.getElementById("fxFeature");
    if (!pre || !live || !live.parsed) return;
    const { feature, scenario, steps } = live.parsed;
    const lines = [];
    if (feature) lines.push({ t: "Feature: " + feature, kind: "meta" });
    if (scenario) lines.push({ t: "Scenario: " + scenario, kind: "meta" });
    steps.forEach((s, i) => {
      lines.push({
        t: s.raw,
        kind: i === stepIndex ? "active" : i < stepIndex ? "done" : "pending",
      });
    });
    pre.innerHTML = lines
      .map((L) => `<span class="fx-line fx-${L.kind}">${escapeHtml(L.t)}</span>`)
      .join("\n");
  }

  async function typeInto(input, value) {
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (const ch of String(value)) {
      input.value += ch;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(22);
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Saccade perception: nearest-neighbor path through candidates.
   * From current gaze, always jump to the closest unevaluated facet, evaluate
   * with pathway activity, reject mismatches, lock on a strong match.
   */
  async function perceive(label, prefer, opts) {
    opts = opts || {};
    const root = siteRoot();
    if (!root || !global.FxPerceive) {
      return { ok: false, detail: "perception unavailable" };
    }
    const LOCK = global.FxPerceive.LOCK_SCORE || 88;
    setPerceive('seeking «' + label + '» — gathering facets…');
    await sleep(60);
    pushSiteVision();

    const pool = global.FxPerceive.saccadePool(root, label, {
      prefer: prefer || [],
      allowText: !!opts.allowText,
      maxGlances: opts.maxGlances || 8,
    });

    if (!pool.length) {
      setPerceive('miss «' + label + '» — empty pool');
      return { ok: false, detail: "not found: " + label };
    }

    // Start from current fly gaze (viewport), else site center.
    const stage = stageEl();
    const site = siteRoot();
    let origin;
    if (stage) {
      const sr = stage.getBoundingClientRect();
      origin = {
        x: sr.left + flyPose.x + FLY_SIZE / 2,
        y: sr.top + flyPose.y + FLY_SIZE / 2,
      };
    } else if (site) {
      origin = global.FxPerceive.elementCenter(site);
    } else {
      origin = { x: 0, y: 0 };
    }

    const path = global.FxPerceive.nearestPath(pool, origin);
    setPerceive(
      "seeking «" + label + "» · " + path.length + " candidates · nearest-neighbor"
    );
    await sleep(80);

    let locked = null;
    let rejected = 0;
    let best = path[0];

    for (let i = 0; i < path.length; i++) {
      const cand = path[i];
      if (!cand.el.isConnected) continue;
      if (!best || cand.score > best.score) best = cand;

      const short = (cand.name || "?").replace(/\s+/g, " ").slice(0, 36);
      setPerceive(
        "nn " +
          (i + 1) +
          "/" +
          path.length +
          " → «" +
          short +
          "» · evaluating…"
      );
      document
        .querySelectorAll(".fx-evaluating, .fx-rejected, .fx-perceived")
        .forEach((el) => el.classList.remove("fx-evaluating", "fx-rejected", "fx-perceived"));
      cand.el.classList.add("fx-evaluating");
      await flyTo(cand.el, "look");
      pushSiteVision();
      await neuralGlance(cand.score);

      if (cand.score >= LOCK) {
        cand.el.classList.remove("fx-evaluating");
        cand.el.classList.add("fx-perceived");
        setPerceive(
          "lock «" +
            short +
            "» · match " +
            cand.score +
            " · rejected " +
            rejected +
            " distractor" +
            (rejected === 1 ? "" : "s")
        );
        if (live && live.hooks) {
          pushBrain(live.hooks, 1, true, true, global.FxPerceive.matchQuality(cand.score));
        }
        await sleep(220);
        if (cand.el.isConnected) cand.el.classList.remove("fx-perceived");
        locked = cand;
        break;
      }

      rejected += 1;
      cand.el.classList.remove("fx-evaluating");
      cand.el.classList.add("fx-rejected");
      setPerceive(
        "reject «" + short + "» · match " + cand.score + " < " + LOCK
      );
      await sleep(200);
      if (cand.el.isConnected) cand.el.classList.remove("fx-rejected");
    }

    if (!locked && best && best.score >= 55 && best.el.isConnected) {
      setPerceive(
        "best-effort «" +
          (best.name || "").slice(0, 36) +
          "» · match " +
          best.score +
          " after " +
          path.length +
          " nn glances"
      );
      best.el.classList.add("fx-perceived");
      await flyTo(best.el, "look");
      if (live && live.hooks) {
        pushBrain(live.hooks, 1, false, true, global.FxPerceive.matchQuality(best.score));
      }
      await sleep(180);
      if (best.el.isConnected) best.el.classList.remove("fx-perceived");
      locked = best;
    }

    if (!locked) {
      setPerceive('miss «' + label + '» after ' + path.length + ' nn glances');
      return { ok: false, detail: "not found: " + label };
    }

    return {
      ok: true,
      hit: locked,
      rejected: rejected,
      glances: path.length,
    };
  }

  function pageNameToView(name) {
    const n = global.FxPerceive.norm(name);
    const map = {
      home: "home",
      catalog: "catalog",
      cart: "cart",
      checkout: "checkout",
      account: "account",
      confirm: "confirm",
      "order confirmed": "confirm",
    };
    return map[n] || n;
  }

  async function runStep(step) {
    const text = step.text;
    let m;

    m = text.match(/^I (?:am on|open|go to|navigate to)(?: the)? "([^"]+)"(?: page)?$/i);
    if (m) {
      const view = pageNameToView(m[1]);
      if (global.FxSite) global.FxSite.go(view);
      await sleep(200);
      const root = siteRoot();
      await flyTo(root, "look");
      setPerceive("navigated → " + view);
      return { ok: true, detail: "on " + view };
    }

    m = text.match(/^I click "([^"]+)"$/i);
    if (m) {
      const perc = await perceive(m[1], ["button", "link"]);
      if (!perc.ok) return perc;
      const el = perc.hit.el;
      await flyTo(el, "hover");
      await flyTo(el, "click");
      el.click();
      await sleep(120);
      // Re-aim after possible view change (old node may be gone).
      await flyTo(siteRoot(), "look");
      return { ok: true, detail: "clicked «" + perc.hit.name.trim().slice(0, 40) + "»" };
    }

    m =
      text.match(/^I (?:fill|type(?: in)?) "([^"]+)" with "([^"]*)"$/i) ||
      text.match(/^I enter "([^"]*)" (?:in|into) "([^"]+)"$/i);
    if (m) {
      // support both "fill X with Y" and "enter Y into X"
      let field = m[1];
      let value = m[2];
      if (/^I enter /i.test(text)) {
        value = m[1];
        field = m[2];
      }
      const perc = await perceive(field, ["textbox", "searchbox"]);
      if (!perc.ok) return perc;
      let input = perc.hit.el;
      if (input.tagName === "LABEL") {
        input =
          input.querySelector("input, textarea") ||
          (input.htmlFor && document.getElementById(input.htmlFor));
      }
      if (!input || !/^(INPUT|TEXTAREA)$/.test(input.tagName)) {
        return { ok: false, detail: "not a text field: " + field };
      }
      await flyTo(input, "hover");
      await typeInto(input, value);
      await flyTo(input, "click");
      return { ok: true, detail: field + " ← " + value };
    }

    m =
      text.match(/^I (?:select|choose) "([^"]+)" as "([^"]+)"$/i) ||
      text.match(/^I (?:select|choose) "([^"]+)" from "([^"]+)"$/i);
    if (m) {
      let field;
      let option;
      if (/ from "/i.test(text)) {
        option = m[1];
        field = m[2];
      } else {
        field = m[1];
        option = m[2];
      }
      setPerceive('scanning choice «' + option + '» in «' + field + '»…');
      const root = siteRoot();
      const hit = global.FxPerceive.findChoice(root, field, option);
      if (!hit) return { ok: false, detail: "choice not found: " + field + " / " + option };
      setPerceive("found choice via " + hit.via + " · score " + hit.score);
      const target = hit.select || hit.el;
      await flyTo(target, "hover");
      if (hit.select && hit.el.tagName === "OPTION") {
        hit.select.value = hit.el.value;
        hit.select.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (hit.el.type === "radio" || hit.el.type === "checkbox") {
        hit.el.checked = true;
        hit.el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (hit.el.tagName === "OPTION") {
        const sel = hit.el.parentElement;
        sel.value = hit.el.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        hit.el.click();
      }
      await flyTo(target, "click");
      return { ok: true, detail: field + " → " + option };
    }

    m = text.match(/^I (?:check|uncheck) "([^"]+)"$/i);
    if (m) {
      const wantOn = /^I check /i.test(text);
      const perc = await perceive(m[1], ["checkbox"]);
      if (!perc.ok) return perc;
      let box = perc.hit.el;
      if (box.tagName === "LABEL") box = box.querySelector('input[type="checkbox"]') || box;
      await flyTo(box, "hover");
      box.checked = wantOn;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      await flyTo(box, "click");
      return { ok: true, detail: (wantOn ? "checked " : "unchecked ") + m[1] };
    }

    m = text.match(/^I submit(?: the form)?$/i);
    if (m) {
      const root = siteRoot();
      const form = root && root.querySelector("form");
      const btn =
        (form && form.querySelector('[type="submit"], button.primary')) ||
        (await perceive("Place order", ["button"])).hit?.el;
      if (!btn && form) {
        form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return { ok: true, detail: "submitted form" };
      }
      if (!btn) return { ok: false, detail: "no submit control" };
      await flyTo(btn, "hover");
      btn.click();
      await flyTo(btn, "click");
      await sleep(160);
      return { ok: true, detail: "submitted" };
    }

    m = text.match(/^I should see "([^"]+)"$/i);
    if (m) {
      const perc = await perceive(m[1], ["heading", "generic"], { allowText: true });
      if (!perc.ok) {
        // Fallback: raw text search in site
        const root = siteRoot();
        const hay = (root && root.innerText) || "";
        if (hay.indexOf(m[1]) !== -1) {
          setPerceive("text present in page");
          await flyTo(root, "look");
          return { ok: true, detail: "saw text «" + m[1] + "»" };
        }
        return { ok: false, detail: "not visible: " + m[1] };
      }
      await flyTo(perc.hit.el, "look");
      return { ok: true, detail: "saw «" + perc.hit.name.trim().slice(0, 40) + "»" };
    }

    return { ok: false, detail: "unknown step: " + text };
  }

  async function runScenario() {
    if (!live || !live.parsed) return;
    const token = ++runToken;
    const hooks = live.hooks;
    const steps = live.parsed.steps;
    const log = document.getElementById("fxLog");
    if (log) log.innerHTML = "";
    if (global.FxSite) global.FxSite.reset();
    setStatus("running…");
    setPerceive("idle");
    setFlyVisible(true);
    live.frac = 0;
    pushBrain(hooks, 0, false, false);
    enableVisualEyes();
    pushSiteVision();

    let failed = false;
    for (let i = 0; i < steps.length; i++) {
      if (token !== runToken) return;
      highlightFeatureLine(i);
      setStatus("step " + (i + 1) + "/" + steps.length);
      let result;
      try {
        result = await runStep(steps[i]);
      } catch (err) {
        result = { ok: false, detail: "exception: " + (err && err.message ? err.message : err) };
        console.error("FX step error", err);
      }
      if (token !== runToken) return;
      live.frac = (i + 1) / steps.length;
      logStep(steps[i].raw + " — " + result.detail, result.ok ? "pass" : "fail");
      pushBrain(hooks, live.frac, !failed && result.ok, false);
      // Eyes refresh after each act so hexes track the changing page.
      pushSiteVision();
      if (!result.ok) {
        failed = true;
        break;
      }
      await sleep(140);
    }

    highlightFeatureLine(steps.length);
    setFlyVisible(true);
    const fly = flyEl();
    if (fly) fly.classList.remove("clicking", "looking");
    setStatus(failed ? "failed" : "passed");
    pushSiteVision();
    if (hooks.noteEl) {
      hooks.noteEl.textContent = failed
        ? "FX scenario failed — perception miss or assertion. See step log."
        : "FX scenario passed — Gherkin drove FlyMart via live DOM perception.";
    }
    if (hooks.tabsEl) {
      hooks.tabsEl.innerHTML = `<button class="tab active" type="button">fx · ${
        failed ? "fail" : "pass"
      }</button>`;
    }
  }

  async function startLive(hooks) {
    await loadScript(FX_BASE + "perceive.js");
    await loadScript(FX_BASE + "site.js");
    await loadScript(FX_BASE + "vision.js");

    ensureChrome(hooks.slot);
    const host = document.getElementById("fxSiteHost");
    if (global.FxSite && host) global.FxSite.mount(host);

    let featureText = "";
    try {
      const res = await fetch(FEATURE_URL);
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      featureText = await res.text();
    } catch (err) {
      featureText =
        'Feature: FlyMart\n  Scenario: fallback\n    Given I am on the "Home" page\n';
      if (hooks.noteEl) {
        hooks.noteEl.textContent =
          "Could not load feature (" + err.message + "). Using fallback.";
      }
    }

    const parsed = parseGherkin(featureText);
    live = { hooks, parsed, featureText, frac: 0 };

    const pre = document.getElementById("fxFeature");
    if (pre) pre.textContent = featureText.trim();
    highlightFeatureLine(-1);

    if (hooks.tabsEl) {
      hooks.tabsEl.innerHTML =
        '<button class="tab active" type="button">fx · FlyMart checkout</button>';
    }
    if (hooks.dotsEl) hooks.dotsEl.innerHTML = "";
    if (hooks.labelEl) hooks.labelEl.textContent = "live gherkin + eyes";
    if (hooks.prevBtn) {
      hooks.prevBtn.disabled = true;
      hooks.prevBtn.textContent = "←";
    }
    if (hooks.nextBtn) {
      hooks.nextBtn.disabled = true;
      hooks.nextBtn.textContent = "→";
    }

    hooks.meta = Object.assign({}, hooks.meta || {}, {
      t_run_ms: 150,
      stages: ["ALPN", "Kenyon_Cell", "MBON", "DAN"],
      stage_labels: {
        ALPN: "ALPN (look)",
        Kenyon_Cell: "Kenyon cell",
        MBON: "MBON",
        DAN: "DAN (QA reward)",
      },
    });
    pushBrain(hooks, 0, false, false);
    startVisionLoop();

    const runBtn = document.getElementById("fxRun");
    if (runBtn) runBtn.onclick = () => runScenario();

    if (hooks.noteEl) {
      hooks.noteEl.textContent =
        "FX · FlyMart — DOM perception for actions; hex eyes average overlapping pixels from the live page.";
    }

    // Auto-run once so the activity is immediately watchable.
    await sleep(200);
    await runScenario();
  }

  function aboutHtml() {
    return `
      <div><strong style="color:var(--text)">How FX “sees” (actions):</strong> gathers role-matched candidates, then saccades by <em>nearest neighbor</em> from current gaze — evaluate / reject / lock — instead of jumping to the best DOM hit.</div>
      <div><strong style="color:var(--text)">How FX “sees” (eyes):</strong> the optic-lobe hex map is a retina — each hex owns an overlapping pixel tile on a live raster of FlyMart; fill = average RGB of that spot.</div>
      <div><strong style="color:var(--text)">How FX acts:</strong> click, fill/type, select/choose, check, submit, assert (“I should see”), navigate.</div>
      <div><strong style="color:var(--text)">Script:</strong> <code>activities/fx/features/flymart_checkout.feature</code></div>`;
  }

  global.FlyActivity = { startLive, aboutHtml };
})(window);
