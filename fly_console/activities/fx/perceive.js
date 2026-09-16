/**
 * FX perception — find interactive elements in the live DOM from human labels.
 * This is the fly's "sight": it reads rendered HTML (same tree Vue would produce),
 * scores candidates by accessible name / text / placeholder / label, then returns
 * the best hit for a Gherkin step to act on.
 */
(function (global) {
  "use strict";

  function norm(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .replace(/[*：:]/g, "")
      .trim()
      .toLowerCase();
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled || el.getAttribute("aria-hidden") === "true") return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function labelFor(el) {
    if (!el || !el.id) return "";
    const esc =
      (window.CSS && CSS.escape) ||
      function (s) {
        return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };
    const lab = el.ownerDocument.querySelector('label[for="' + esc(el.id) + '"]');
    return lab ? lab.textContent : "";
  }

  function accessibleName(el) {
    if (!el) return "";
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      return labelledby
        .split(/\s+/)
        .map((id) => {
          const n = el.ownerDocument.getElementById(id);
          return n ? n.textContent : "";
        })
        .join(" ");
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const lab = labelFor(el);
      if (lab) return lab;
      if (el.getAttribute("placeholder")) return el.getAttribute("placeholder");
      if (el.getAttribute("name")) return el.getAttribute("name");
      if (el.getAttribute("title")) return el.getAttribute("title");
      return "";
    }
    if (el.tagName === "IMG") return el.getAttribute("alt") || "";
    // Prefer own text without deep nested control noise for buttons/links
    if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") {
      return el.textContent || "";
    }
    return el.textContent || "";
  }

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "BUTTON") return "button";
    if (tag === "A") return "link";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "submit" || t === "button") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (tag === "OPTION") return "option";
    if (/^H[1-6]$/.test(tag)) return "heading";
    return "generic";
  }

  function scoreMatch(want, got, kindBonus) {
    const w = norm(want);
    const g = norm(got);
    if (!w || !g) return 0;
    let s = 0;
    if (g === w) s = 100;
    else if (g.startsWith(w)) s = 88;
    else if (g.includes(w)) s = 72;
    else if (w.includes(g) && g.length >= 3) s = 55;
    else return 0;
    return s + (kindBonus || 0);
  }

  /**
   * Ranked match list (score order). Used for scoring; visit order is separate.
   */
  function findAll(root, name, opts) {
    opts = opts || {};
    const prefer = (opts.prefer || []).map((r) => r.toLowerCase());
    const want = norm(name);
    if (!root || !want) return [];

    const candidates = [];
    const seen = new Set();

    function push(el, score, via, nm) {
      if (!el || seen.has(el) || score <= 0) return;
      seen.add(el);
      candidates.push({
        el,
        score,
        via,
        name: (nm || accessibleName(el) || "").trim(),
        role: roleOf(el),
      });
    }

    const nodes = root.querySelectorAll(
      "button, a, input, textarea, select, option, [role='button'], [role='link'], [role='textbox'], [role='menuitem'], label, [data-fx-target]"
    );

    nodes.forEach((el) => {
      if (!visible(el)) return;
      const role = roleOf(el);
      const nm = accessibleName(el);
      let kindBonus = 0;
      if (prefer.length) {
        if (prefer.indexOf(role) !== -1) kindBonus = 15;
        else if (prefer.indexOf("button") !== -1 && role === "link") kindBonus = 8;
      }
      push(el, scoreMatch(want, nm, kindBonus), "name:" + role, nm);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        push(
          el,
          scoreMatch(want, el.getAttribute("placeholder") || "", kindBonus + 5),
          "placeholder",
          el.getAttribute("placeholder")
        );
      }
    });

    root.querySelectorAll("[data-product], .fx-product, h1, h2, h3, .fx-nav-link").forEach((el) => {
      if (!visible(el)) return;
      push(
        el,
        scoreMatch(want, el.textContent, prefer.indexOf("heading") !== -1 ? 10 : 0),
        "text",
        el.textContent
      );
    });

    if (opts.allowText) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walk.nextNode())) {
        if (!visible(n)) continue;
        if (n.children.length > 3) continue;
        const t = (n.textContent || "").trim();
        if (!t || t.length > 120) continue;
        const sc = scoreMatch(want, t, 0);
        if (sc >= 72) push(n, sc, "body-text", t);
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  function find(root, name, opts) {
    return findAll(root, name, opts)[0] || null;
  }

  /**
   * Saccade pool: elements the fly must look at and evaluate.
   * Unordered set of preferred-role distractors + true matches.
   * Visit order is nearest-neighbor from the fly's current pose (see nearestPath).
   */
  function saccadePool(root, name, opts) {
    opts = opts || {};
    const prefer = (opts.prefer || []).map((r) => r.toLowerCase());
    const want = norm(name);
    const maxGlances = opts.maxGlances || 8;
    const scored = findAll(root, name, opts);
    const byEl = new Map();
    scored.forEach((c) => byEl.set(c.el, c));

    const pool = [];
    const seen = new Set();

    function add(el, meta) {
      if (!el || seen.has(el) || !visible(el)) return;
      seen.add(el);
      const existing = byEl.get(el);
      pool.push(
        existing || {
          el,
          score: meta && meta.score != null ? meta.score : scoreMatch(want, accessibleName(el)),
          via: (meta && meta.via) || "distract:" + roleOf(el),
          name: (accessibleName(el) || el.textContent || "").trim().slice(0, 80),
          role: roleOf(el),
        }
      );
    }

    if (prefer.length) {
      const sel = [
        prefer.indexOf("button") !== -1 || prefer.indexOf("link") !== -1
          ? "button, a, [role='button'], [role='link'], .fx-nav-link, .fx-btn"
          : "",
        prefer.indexOf("textbox") !== -1 || prefer.indexOf("searchbox") !== -1
          ? "input:not([type=radio]):not([type=checkbox]):not([type=submit]), textarea"
          : "",
        prefer.indexOf("combobox") !== -1 ? "select" : "",
        prefer.indexOf("checkbox") !== -1 ? 'input[type="checkbox"], label' : "",
        prefer.indexOf("heading") !== -1 || prefer.indexOf("generic") !== -1
          ? "h1, h2, h3, .fx-product, [data-product]"
          : "",
      ]
        .filter(Boolean)
        .join(", ");
      if (sel) {
        root.querySelectorAll(sel).forEach((el) => add(el));
      }
    }

    scored.forEach((c) => add(c.el));

    if (pool.length <= maxGlances) return pool;
    const best = scored[0];
    const head = pool.slice(0, maxGlances);
    if (best && !head.some((c) => c.el === best.el)) {
      head[head.length - 1] = best;
    }
    return head;
  }

  function elementCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  /**
   * Greedy nearest-neighbor path through candidates from a starting point.
   * @param {Array} pool
   * @param {{x:number,y:number}} origin - usually current fly gaze in viewport coords
   */
  function nearestPath(pool, origin) {
    const remaining = pool.slice();
    const ordered = [];
    let here = origin || { x: 0, y: 0 };
    while (remaining.length) {
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        if (!remaining[i].el || !remaining[i].el.isConnected) continue;
        const d = dist2(here, elementCenter(remaining[i].el));
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      const next = remaining.splice(bestI, 1)[0];
      if (!next) break;
      ordered.push(next);
      if (next.el && next.el.isConnected) here = elementCenter(next.el);
    }
    return ordered;
  }

  /** Match quality 0..1 for neural readout. */
  function matchQuality(score) {
    return Math.max(0, Math.min(1, (Number(score) || 0) / 115));
  }

  /** Resolve a field group + optional option (radio/select/checkbox). */
  function findChoice(root, fieldName, optionName) {
    const field = find(root, fieldName, {
      prefer: ["textbox", "combobox", "radiogroup", "generic"],
    });
    // Search radios/checkboxes by option label near a matching legend/label
    const wantField = norm(fieldName);
    const wantOpt = norm(optionName);
    let best = null;

    root.querySelectorAll("fieldset, .fx-field, label").forEach((wrap) => {
      if (!visible(wrap)) return;
      const header = wrap.tagName === "FIELDSET"
        ? (wrap.querySelector("legend") || {}).textContent || ""
        : wrap.textContent || "";
      if (scoreMatch(fieldName, header) < 55 && norm(header).indexOf(wantField) === -1) {
        // still allow global option search
      } else {
        wrap.querySelectorAll("label, option").forEach((lab) => {
          if (!visible(lab)) return;
          const sc = scoreMatch(optionName, lab.textContent, 20);
          if (sc <= 0) return;
          let el = lab;
          if (lab.tagName === "LABEL") {
            const input = lab.querySelector("input, select") ||
              (lab.htmlFor &&
                root.querySelector(
                  "#" +
                    ((window.CSS && CSS.escape) || ((s) => s))(lab.htmlFor)
                ));
            if (input) el = input;
          }
          if (!best || sc > best.score) best = { el, score: sc, via: "choice", name: lab.textContent.trim() };
        });
      }
    });

    root.querySelectorAll("select").forEach((sel) => {
      if (!visible(sel)) return;
      const fieldHit = scoreMatch(fieldName, accessibleName(sel));
      if (fieldHit < 55) return;
      Array.from(sel.options).forEach((opt) => {
        const sc = scoreMatch(optionName, opt.text, fieldHit);
        if (sc > 0 && (!best || sc > best.score)) {
          best = { el: opt, score: sc, via: "select-option", name: opt.text, select: sel };
        }
      });
    });

    // Fallback: option text alone
    if (!best) {
      root.querySelectorAll("label, option").forEach((lab) => {
        if (!visible(lab)) return;
        const sc = scoreMatch(optionName, lab.textContent);
        if (sc < 72) return;
        let el = lab.tagName === "OPTION" ? lab : lab.querySelector("input") || lab;
        if (!best || sc > best.score) best = { el, score: sc, via: "option-only", name: lab.textContent.trim() };
      });
    }

    return best;
  }

  global.FxPerceive = {
    norm,
    visible,
    accessibleName,
    find,
    findAll,
    saccadePool,
    nearestPath,
    elementCenter,
    matchQuality,
    findChoice,
    LOCK_SCORE: 88,
  };
})(window);
