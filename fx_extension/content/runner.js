/**
 * FX content runner — Gherkin on the live page with nearest-neighbor perception.
 * Depends on content/perceive.js (FxPerceive) injected first.
 */
(function () {
  "use strict";

  if (window.__fxExtRunner) return;
  window.__fxExtRunner = true;

  const FLY_SIZE = 56;
  const FLY_URL = chrome.runtime.getURL("assets/fly_topdown.gif");

  let runToken = 0;
  let flyPose = { x: 24, y: 24, angle: 0 };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function emit(msg) {
    try {
      chrome.runtime.sendMessage(Object.assign({ source: "fx-ext" }, msg));
    } catch (_) {
      /* panel may be closed */
    }
  }

  function parseGherkin(text) {
    const lines = String(text || "").split(/\r?\n/);
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
      if (step) steps.push({ keyword: step[1], text: step[2].trim(), raw: line });
    }
    return { feature, scenario, steps };
  }

  function ensureFly() {
    let fly = document.getElementById("fx-ext-fly");
    if (fly) return fly;
    fly = document.createElement("div");
    fly.id = "fx-ext-fly";
    fly.setAttribute("aria-hidden", "true");
    const img = document.createElement("img");
    img.src = FLY_URL;
    img.width = FLY_SIZE;
    img.height = FLY_SIZE;
    img.alt = "";
    fly.appendChild(img);
    document.documentElement.appendChild(fly);
    applyFlyPose(fly, flyPose.x, flyPose.y, flyPose.angle);
    return fly;
  }

  function applyFlyPose(fly, x, y, angle) {
    flyPose = { x, y, angle };
    fly.style.transform = "translate(" + x + "px, " + y + "px) rotate(" + angle + "deg)";
  }

  function setFlyVisible(on) {
    ensureFly().classList.toggle("visible", !!on);
  }

  function flyTo(el, mode) {
    const fly = ensureFly();
    const target =
      el && el.nodeType === 1 && el.isConnected
        ? el
        : document.documentElement;
    try {
      const r = target.getBoundingClientRect();
      const x = r.left + Math.max(r.width, 4) / 2 - FLY_SIZE / 2;
      const y = r.top + Math.min(Math.max(r.height, 4) / 2, 48) - FLY_SIZE / 2;
      const dx = x - flyPose.x;
      const dy = y - flyPose.y;
      let angle = flyPose.angle;
      if (Math.hypot(dx, dy) > 6) {
        angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
      }
      applyFlyPose(fly, x, y, angle);
      // Keep fly on screen if element scrolled far
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      }
    } catch (_) {
      /* ignore */
    }
    fly.classList.toggle("clicking", mode === "click");
    fly.classList.toggle("looking", mode === "look" || mode === "hover");
    setFlyVisible(true);
    return sleep(mode === "click" ? 240 : 320);
  }

  function clearMarks() {
    document
      .querySelectorAll(".fx-ext-evaluating, .fx-ext-rejected, .fx-ext-perceived")
      .forEach((el) =>
        el.classList.remove("fx-ext-evaluating", "fx-ext-rejected", "fx-ext-perceived")
      );
  }

  async function typeInto(input, value) {
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (const ch of String(value)) {
      input.value += ch;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(18);
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function siteRoot() {
    return document.body || document.documentElement;
  }

  async function perceive(label, prefer, opts) {
    opts = opts || {};
    const root = siteRoot();
    if (!window.FxPerceive) {
      return { ok: false, detail: "FxPerceive missing" };
    }
    const LOCK = window.FxPerceive.LOCK_SCORE || 88;
    emit({ type: "FX_PERCEIVE", text: "seeking «" + label + "»…" });

    const pool = window.FxPerceive.saccadePool(root, label, {
      prefer: prefer || [],
      allowText: !!opts.allowText,
      maxGlances: opts.maxGlances || 10,
    });
    if (!pool.length) {
      emit({ type: "FX_PERCEIVE", text: "miss «" + label + "»" });
      return { ok: false, detail: "not found: " + label };
    }

    const origin = {
      x: flyPose.x + FLY_SIZE / 2,
      y: flyPose.y + FLY_SIZE / 2,
    };
    const path = window.FxPerceive.nearestPath(pool, origin);
    emit({
      type: "FX_PERCEIVE",
      text: "seeking «" + label + "» · " + path.length + " · nearest-neighbor",
    });

    let locked = null;
    let rejected = 0;
    let best = path[0];

    for (let i = 0; i < path.length; i++) {
      const cand = path[i];
      if (!cand.el.isConnected) continue;
      if (!best || cand.score > best.score) best = cand;
      const short = (cand.name || "?").replace(/\s+/g, " ").slice(0, 40);
      emit({
        type: "FX_PERCEIVE",
        text: "nn " + (i + 1) + "/" + path.length + " → «" + short + "»",
      });
      clearMarks();
      cand.el.classList.add("fx-ext-evaluating");
      await flyTo(cand.el, "look");
      await sleep(120 + Math.round(80 * (1 - window.FxPerceive.matchQuality(cand.score))));

      if (cand.score >= LOCK) {
        cand.el.classList.remove("fx-ext-evaluating");
        cand.el.classList.add("fx-ext-perceived");
        emit({
          type: "FX_PERCEIVE",
          text: "lock «" + short + "» · match " + cand.score + " · rejected " + rejected,
        });
        await sleep(180);
        clearMarks();
        locked = cand;
        break;
      }
      rejected += 1;
      cand.el.classList.remove("fx-ext-evaluating");
      cand.el.classList.add("fx-ext-rejected");
      emit({
        type: "FX_PERCEIVE",
        text: "reject «" + short + "» · match " + cand.score,
      });
      await sleep(140);
      clearMarks();
    }

    if (!locked && best && best.score >= 55 && best.el.isConnected) {
      emit({
        type: "FX_PERCEIVE",
        text: "best-effort «" + (best.name || "").slice(0, 36) + "» · " + best.score,
      });
      best.el.classList.add("fx-ext-perceived");
      await flyTo(best.el, "look");
      await sleep(140);
      clearMarks();
      locked = best;
    }

    if (!locked) return { ok: false, detail: "not found: " + label };
    return { ok: true, hit: locked, rejected: rejected };
  }

  async function runStep(step) {
    const text = step.text;
    let m;

    m = text.match(/^I (?:am on|open|go to|navigate to)(?: the)? "([^"]+)"(?: page)?$/i);
    if (m) {
      const label = m[1];
      const perc = await perceive(label, ["link", "button", "heading"], { allowText: true });
      if (perc.ok) {
        await flyTo(perc.hit.el, "hover");
        await flyTo(perc.hit.el, "click");
        if (perc.hit.el.tagName === "A" || perc.hit.el.getAttribute("role") === "link" || perc.hit.el.tagName === "BUTTON") {
          perc.hit.el.click();
          await sleep(400);
        }
        return { ok: true, detail: "navigated via «" + (perc.hit.name || label).slice(0, 40) + "»" };
      }
      // Soft success: already on a page that shows the label
      const hay = (document.body && document.body.innerText) || "";
      if (hay.toLowerCase().indexOf(label.toLowerCase()) !== -1) {
        await flyTo(document.body, "look");
        return { ok: true, detail: "already seeing «" + label + "»" };
      }
      return perc;
    }

    m = text.match(/^I click "([^"]+)"$/i);
    if (m) {
      const perc = await perceive(m[1], ["button", "link"]);
      if (!perc.ok) return perc;
      const el = perc.hit.el;
      await flyTo(el, "hover");
      await flyTo(el, "click");
      el.click();
      await sleep(200);
      await flyTo(document.body, "look");
      return { ok: true, detail: "clicked «" + (perc.hit.name || "").slice(0, 40) + "»" };
    }

    m =
      text.match(/^I (?:fill|type(?: in)?) "([^"]+)" with "([^"]*)"$/i) ||
      text.match(/^I enter "([^"]*)" (?:in|into) "([^"]+)"$/i);
    if (m) {
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
      emit({ type: "FX_PERCEIVE", text: "choice «" + option + "» in «" + field + "»" });
      const hit = window.FxPerceive.findChoice(siteRoot(), field, option);
      if (!hit) return { ok: false, detail: "choice not found: " + field + " / " + option };
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
      const form = document.querySelector("form");
      const btn =
        (form && form.querySelector('[type="submit"], button')) ||
        (await perceive("Submit", ["button"])).hit?.el;
      if (!btn && form) {
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return { ok: true, detail: "submitted form" };
      }
      if (!btn) return { ok: false, detail: "no submit control" };
      await flyTo(btn, "hover");
      btn.click();
      await flyTo(btn, "click");
      return { ok: true, detail: "submitted" };
    }

    m = text.match(/^I should see "([^"]+)"$/i);
    if (m) {
      const perc = await perceive(m[1], ["heading", "generic"], { allowText: true });
      if (!perc.ok) {
        const hay = (document.body && document.body.innerText) || "";
        if (hay.indexOf(m[1]) !== -1) {
          await flyTo(document.body, "look");
          return { ok: true, detail: "saw text «" + m[1] + "»" };
        }
        return { ok: false, detail: "not visible: " + m[1] };
      }
      await flyTo(perc.hit.el, "look");
      return { ok: true, detail: "saw «" + (perc.hit.name || "").slice(0, 40) + "»" };
    }

    m = text.match(/^I wait(?: for)? (\d+(?:\.\d+)?)s?$/i);
    if (m) {
      const sec = Number(m[1]);
      await sleep(Math.min(30000, sec * 1000));
      return { ok: true, detail: "waited " + sec + "s" };
    }

    return { ok: false, detail: "unknown step: " + text };
  }

  async function runScenario(featureText) {
    const token = ++runToken;
    const parsed = parseGherkin(featureText);
    const steps = parsed.steps;
    if (!steps.length) {
      emit({ type: "FX_DONE", ok: false, detail: "no steps in feature" });
      return;
    }
    ensureFly();
    setFlyVisible(true);
    emit({
      type: "FX_STATUS",
      text: "running · " + (parsed.scenario || parsed.feature || "scenario"),
    });
    emit({ type: "FX_LOG_CLEAR" });

    let failed = false;
    for (let i = 0; i < steps.length; i++) {
      if (token !== runToken) return;
      emit({
        type: "FX_STATUS",
        text: "step " + (i + 1) + "/" + steps.length,
        stepIndex: i,
        nSteps: steps.length,
        stepRaw: steps[i].raw,
      });
      let result;
      try {
        result = await runStep(steps[i]);
      } catch (err) {
        result = { ok: false, detail: "exception: " + (err && err.message ? err.message : err) };
      }
      if (token !== runToken) return;
      emit({
        type: "FX_LOG",
        ok: !!result.ok,
        text: steps[i].raw + " — " + result.detail,
      });
      if (!result.ok) {
        failed = true;
        break;
      }
      await sleep(100);
    }

    const fly = document.getElementById("fx-ext-fly");
    if (fly) fly.classList.remove("clicking", "looking");
    emit({
      type: "FX_DONE",
      ok: !failed,
      text: failed ? "failed" : "passed",
    });
    emit({ type: "FX_STATUS", text: failed ? "failed" : "passed" });
  }

  function stopScenario() {
    runToken += 1;
    clearMarks();
    emit({ type: "FX_STATUS", text: "stopped" });
    emit({ type: "FX_DONE", ok: false, text: "stopped" });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "fx-content") return;
    if (msg.type === "FX_PING") {
      sendResponse({ ok: true, ready: true });
      return true;
    }
    if (msg.type === "FX_RUN") {
      runScenario(msg.feature || "");
      sendResponse({ ok: true, started: true });
      return true;
    }
    if (msg.type === "FX_STOP") {
      stopScenario();
      sendResponse({ ok: true });
      return true;
    }
  });

  emit({ type: "FX_READY", text: "content ready · " + location.hostname });
})();
