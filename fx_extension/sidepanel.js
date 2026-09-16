/**
 * FX side panel — edit Gherkin, inject runner into active tab, stream logs.
 */
(function () {
  "use strict";

  const DEFAULT_FEATURE = `Feature: Smoke the active page
  Scenario: Find something clickable
    When I click "Sign in"
    Then I should see "Password"
`;

  const featureEl = document.getElementById("feature");
  const statusEl = document.getElementById("status");
  const perceiveEl = document.getElementById("perceive");
  const logEl = document.getElementById("log");
  const runBtn = document.getElementById("runBtn");
  const stopBtn = document.getElementById("stopBtn");

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }

  function setPerceive(t) {
    if (perceiveEl) perceiveEl.textContent = t;
  }

  function clearLog() {
    if (logEl) logEl.innerHTML = "";
  }

  function addLog(text, ok) {
    if (!logEl) return;
    const li = document.createElement("li");
    li.className = ok ? "pass" : "fail";
    li.textContent = text;
    logEl.appendChild(li);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function loadStored() {
    try {
      const stored = await chrome.storage.local.get(["fxFeature"]);
      featureEl.value = stored.fxFeature || DEFAULT_FEATURE;
    } catch (_) {
      featureEl.value = DEFAULT_FEATURE;
    }
  }

  featureEl.addEventListener("change", () => {
    chrome.storage.local.set({ fxFeature: featureEl.value });
  });
  featureEl.addEventListener("blur", () => {
    chrome.storage.local.set({ fxFeature: featureEl.value });
  });

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  async function ensureInjected(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { target: "fx-content", type: "FX_PING" });
      return true;
    } catch (_) {
      /* not injected yet */
    }
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/fly.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/perceive.js", "content/runner.js"],
    });
    // brief settle
    await new Promise((r) => setTimeout(r, 80));
    return true;
  }

  async function run() {
    const tab = await activeTab();
    if (!tab || tab.id == null) {
      setStatus("no active tab");
      return;
    }
    if (!tab.url || !/^https?:/i.test(tab.url)) {
      setStatus("open an http(s) page first");
      addLog("Cannot run on chrome:// or extension pages", false);
      return;
    }
    chrome.storage.local.set({ fxFeature: featureEl.value });
    setStatus("injecting…");
    clearLog();
    try {
      await ensureInjected(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        target: "fx-content",
        type: "FX_RUN",
        feature: featureEl.value,
      });
      setStatus("running…");
    } catch (err) {
      setStatus("inject failed");
      addLog(String(err && err.message ? err.message : err), false);
    }
  }

  async function stop() {
    const tab = await activeTab();
    if (!tab || tab.id == null) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { target: "fx-content", type: "FX_STOP" });
    } catch (_) {
      setStatus("stopped");
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.source !== "fx-ext") return;
    if (msg.type === "FX_STATUS") setStatus(msg.text || "");
    if (msg.type === "FX_PERCEIVE") setPerceive(msg.text || "");
    if (msg.type === "FX_LOG_CLEAR") clearLog();
    if (msg.type === "FX_LOG") addLog(msg.text || "", !!msg.ok);
    if (msg.type === "FX_DONE") setStatus(msg.text || (msg.ok ? "passed" : "failed"));
    if (msg.type === "FX_READY") setPerceive(msg.text || "ready");
  });

  runBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", stop);
  loadStored();
})();
