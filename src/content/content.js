// Content script entry point. The FAB + drawer + clipboard bookkeeping
// run on every page (<all_urls>). The card-detection / rewriting
// pipeline is driven by per-site settings in CM.siteSettings:
//
//   off     — nothing runs. Cards on Page is empty.
//   detect  — read-only scan. Populates CM.detectedCardNames so the
//             Cards on Page tab can list hits. Page DOM untouched.
//   full    — full rewriter: anchors on text-node matches, hover
//             tooltip on document, adapter styles, "+" buttons,
//             MutationObserver-driven rescans.
//
// Adapter-matched sites default to "full". All other sites default to
// "off". Users flip the per-site toggles in the drawer.
(function () {
  const CM = window.CM;
  if (!CM) return;

  const adapter = CM.pickAdapter(location.hostname);

  // Generic fallback used when the current site has no matching adapter
  // but the user enables detection/hyperlinks anyway.
  const GENERIC_ADAPTER = {
    name: "generic",
    root: () => document.body,
    skipSelectors: [
      "a.cm-card-link",
      "button.cm-card-plus",
      ".cm-hover-tooltip",
      "script", "style", "code", "pre",
      "textarea", "input", "button", "select",
      "nav", "header", "footer",
    ],
  };

  function effectiveAdapter() { return adapter || GENERIC_ADAPTER; }

  // ----- state -----
  let catalog = null;         // raw array of Scryfall names; reused by ensureTrie
  let trie = null;
  let observer = null;
  let observerMode = null;    // which mode the observer was attached under
  let scanning = false;
  let pendingRescan = false;
  let docHoverInstalled = false;
  let adapterStyleEl = null;
  let inMode = "off";         // "off" | "detect" | "full"

  function currentRoots() {
    const a = effectiveAdapter();
    const r = a.root();
    if (!r) return [];
    return Array.isArray(r) ? r.filter(Boolean) : [r];
  }

  function ensureTrie() {
    if (trie || !catalog) return;
    trie = CM.matcher.makeTrie(catalog);
  }

  // ----- full mode (rewriter) -----

  function fullScan() {
    if (!trie) return;
    if (scanning) { pendingRescan = true; return; }
    scanning = true;
    try {
      const a = effectiveAdapter();
      for (const root of currentRoots()) {
        CM.rewriter.rewrite(root, trie, a);
      }
    } catch (e) {
      console.error("[CardMystic] rewrite failed", e);
    } finally {
      scanning = false;
      if (pendingRescan) {
        pendingRescan = false;
        requestAnimationFrame(fullScan);
      }
    }
  }

  // ----- detect mode (read-only scan) -----

  function runDetect() {
    if (!trie) return;
    const a = effectiveAdapter();
    const out = new Set();
    for (const root of currentRoots()) {
      const s = CM.rewriter.collect(root, trie, a);
      for (const k of s) out.add(k);
    }
    CM.detectedCardNames = out;
    document.dispatchEvent(new CustomEvent("cm:detectedchanged"));
  }

  // ----- observer -----

  function attachObserver(forMode) {
    if (observer && observerMode === forMode) return;
    detachObserver();
    const target = document.body;
    if (!target) return;
    observer = new MutationObserver((records) => {
      // Cheap early-exit on "nothing added" bursts.
      let added = false;
      for (const r of records) {
        if (r.addedNodes && r.addedNodes.length) { added = true; break; }
      }
      if (!added) return;
      if (forMode === "full") {
        pendingRescan = true;
        requestAnimationFrame(fullScan);
      } else {
        requestAnimationFrame(runDetect);
      }
    });
    observer.observe(target, { childList: true, subtree: true });
    observerMode = forMode;
  }

  function detachObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    observerMode = null;
  }

  // ----- adapter CSS (only for adapter-matched sites in full mode) -----

  function injectAdapterStyles() {
    if (adapterStyleEl) return;
    if (!adapter || !adapter.styles) return;
    const style = document.createElement("style");
    style.dataset.cmAdapter = adapter.name || "cm";
    style.textContent = adapter.styles;
    (document.head || document.documentElement).appendChild(style);
    adapterStyleEl = style;
  }

  function removeAdapterStyles() {
    if (adapterStyleEl && adapterStyleEl.parentNode) {
      adapterStyleEl.parentNode.removeChild(adapterStyleEl);
    }
    adapterStyleEl = null;
  }

  // ----- mode transitions -----

  function enterFull() {
    ensureTrie();
    injectAdapterStyles();
    if (!docHoverInstalled && CM.hover && CM.hover.install) {
      CM.hover.install();
      docHoverInstalled = true;
    }
    fullScan();
    attachObserver("full");
  }

  function leaveFull() {
    detachObserver();
    try { CM.rewriter.unrewrite(document); }
    catch (err) { console.warn("[CardMystic] unrewrite failed", err); }
    removeAdapterStyles();
    // Leave docHoverInstalled alone — the document-level listener is
    // harmless when there are no [data-cm-card] elements, and
    // reinstalling would just duplicate the listener.
  }

  function enterDetect() {
    ensureTrie();
    runDetect();
    attachObserver("detect");
  }

  function leaveDetect() {
    detachObserver();
    CM.detectedCardNames = null;
    document.dispatchEvent(new CustomEvent("cm:detectedchanged"));
  }

  function applyMode(want) {
    if (want === inMode) return;
    // Leave old.
    if (inMode === "full") leaveFull();
    else if (inMode === "detect") leaveDetect();
    // Enter new.
    if (want === "full") enterFull();
    else if (want === "detect") enterDetect();
    inMode = want;
  }

  function modeFromSettings(s) {
    if (!s || !s.discover) return "off";
    return s.hyperlinks ? "full" : "detect";
  }

  function applySettings() {
    if (!CM.siteSettings) return;
    const s = CM.siteSettings.get(location.hostname);
    applyMode(modeFromSettings(s));
  }

  // ----- boot -----

  function boot() {
    chrome.runtime.sendMessage({ type: "getCardNames" }, async (resp) => {
      if (!resp || !resp.ok) {
        console.warn("[CardMystic] card-names fetch failed", resp && resp.error);
        bringUpLiteSurface();
        return;
      }
      catalog = resp.data;

      // Card-name Set + face index for parseDeckList / clipboard bookkeeping.
      // CM.cardNamesDisplay maps normalized key → original-cased name so
      // the Cards on Page tab can show "Sol Ring" instead of "sol ring"
      // when rendering from a detect-mode Set of canonical keys.
      CM.cardNames = new Set();
      CM.cardNamesDisplay = new Map();
      for (const original of catalog) {
        if (typeof original !== "string") continue;
        const norm = CM.matcher.normalize(original);
        CM.cardNames.add(norm);
        if (!CM.cardNamesDisplay.has(norm)) CM.cardNamesDisplay.set(norm, original);
      }
      CM.cardFaces = new Map();
      for (const original of catalog) {
        if (typeof original !== "string" || original.indexOf(" // ") < 0) continue;
        const canonical = CM.matcher.normalize(original);
        for (const part of canonical.split(" // ")) {
          const face = part.trim();
          if (!face || face === canonical) continue;
          if (CM.cardNames.has(face)) continue;
          if (CM.cardFaces.has(face)) continue;
          CM.cardFaces.set(face, canonical);
        }
      }

      // Always-on surfaces.
      if (CM.plus && CM.plus.install) CM.plus.install();
      if (CM.history && CM.history.init) CM.history.init();
      if (CM.fab && CM.fab.install) CM.fab.install();

      // Settings-driven pipeline.
      if (CM.siteSettings && CM.siteSettings.init) {
        await CM.siteSettings.init();
      }
      applySettings();
      document.addEventListener("cm:sitesettingschanged", (e) => {
        const h = e.detail && e.detail.hostname;
        if (h && h !== location.hostname) return;
        applySettings();
      });
    });
  }

  // Minimal bring-up when the catalog isn't available yet. FAB and
  // right-click clear still work; classification will start working
  // once a later page hits the cache.
  function bringUpLiteSurface() {
    if (CM.plus && CM.plus.install) CM.plus.install();
    if (CM.history && CM.history.init) CM.history.init();
    if (CM.fab && CM.fab.install) CM.fab.install();
    // sitesettings listeners still need to initialize so subsequent
    // loads can see user changes.
    if (CM.siteSettings && CM.siteSettings.init) CM.siteSettings.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
