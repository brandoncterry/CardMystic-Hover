// Content script entry point. Picks an adapter for the current host, fetches
// the Scryfall card-names catalog from the background, builds a trie, and
// runs the rewriter. A MutationObserver re-scans the page when content is
// added (SPA navigation, infinite scroll, lazy-loaded comments, etc.).
//
// adapter.root() may return a single Element or an array of Elements. The
// adapter can return an empty array on initial boot (e.g. reddit before the
// post loads) — the MutationObserver will trigger a rescan once content
// appears.
(function () {
  const CM = window.CM;
  if (!CM) return;

  const adapter = CM.pickAdapter(location.hostname);
  if (!adapter) return;

  let trie = null;
  let scanning = false;
  let pendingRescan = false;

  function currentRoots() {
    const r = adapter.root();
    if (!r) return [];
    return Array.isArray(r) ? r.filter(Boolean) : [r];
  }

  function scan() {
    if (!trie) return;
    if (scanning) { pendingRescan = true; return; }
    scanning = true;
    try {
      const roots = currentRoots();
      for (const root of roots) {
        CM.rewriter.rewrite(root, trie, adapter);
      }
    } catch (e) {
      console.error("[CardMystic] rewrite failed", e);
    } finally {
      scanning = false;
      if (pendingRescan) {
        pendingRescan = false;
        requestAnimationFrame(scan);
      }
    }
  }

  function observe() {
    // Always observe document.body so SPA routing and late content are caught.
    // The rewriter itself filters out skipped subtrees.
    const target = document.body;
    if (!target) return;
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.addedNodes && r.addedNodes.length) {
          pendingRescan = true;
          break;
        }
      }
      if (pendingRescan) requestAnimationFrame(scan);
    });
    obs.observe(target, { childList: true, subtree: true });
  }

  // Inject any adapter-provided CSS at the earliest moment we have a <head>
  // or <html>. Used to neutralize host-site hover overlays that can't be
  // killed via DOM manipulation alone (e.g. React-managed popups that
  // re-mount on every mouseenter).
  function injectAdapterStyles() {
    if (!adapter.styles) return;
    const style = document.createElement("style");
    style.dataset.cmAdapter = adapter.name || "cm";
    style.textContent = adapter.styles;
    (document.head || document.documentElement).appendChild(style);
  }

  function boot() {
    chrome.runtime.sendMessage({ type: "getCardNames" }, (resp) => {
      if (!resp || !resp.ok) {
        console.warn("[CardMystic] card-names fetch failed", resp && resp.error);
        return;
      }
      trie = CM.matcher.makeTrie(resp.data);
      scan();
      CM.hover.install();
      observe();
    });
  }

  // Inject styles as early as possible — before the card-names fetch returns —
  // so the host site's hover popup is hidden even on the very first hover.
  injectAdapterStyles();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
