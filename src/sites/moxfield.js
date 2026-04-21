// Moxfield site adapter.
//
// Covers deck pages under moxfield.com/decks/*. Moxfield is a React SPA, so
// the content is injected after page load and can re-mount on navigation.
// The MutationObserver in content.js watches document.body, so SPA route
// changes and late-loading comments are picked up automatically.
//
// Moxfield does not ship its own card hover preview, so we don't need any
// class/attribute stripping or a postOverride hook — clean `href` overrides
// are enough.
//
// The heavy lift for performance on this site is in the background worker:
// `src/background/scryfall.js` batches lookups via POST /cards/collection,
// so a ~100-card deck resolves in ~2 HTTP calls instead of ~100.
//
// NOTE: Because Moxfield blocks scraping, the root selectors below are
// educated guesses. If a section of a deck page is not being tagged, open
// DevTools and look for the container wrapping the relevant prose or
// decklist table, then add it to ROOT_SELECTORS.
(function () {
  const CM = (window.CM = window.CM || {});
  CM.adapters = CM.adapters || [];

  const ROOT_SELECTORS = [
    // Deck description / notes (primary target — the author's prose)
    ".deck-description",
    ".deckdescription",
    ".deck-notes",
    // Comments
    ".comment-body",
    ".comments",
    // Decklist areas — existing card anchors here get their href overridden
    ".deckview",
    ".decklist",
    ".mainboard",
    ".sideboard",
  ];

  CM.adapters.push({
    name: "moxfield",
    host: /(^|\.)moxfield\.com$/,
    root() {
      // Only run on deck pages.
      if (!/^\/decks(\/|$)/.test(location.pathname)) return null;

      const out = [];
      const seen = new Set();
      for (const sel of ROOT_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          // Skip containers already inside a collected one so we don't
          // rewrite the same text twice.
          let nested = false;
          for (const other of seen) {
            if (other.contains(el)) { nested = true; break; }
          }
          if (nested) continue;
          seen.add(el);
          out.push(el);
        }
      }

      // If none of the specific containers exist yet (early SPA boot),
      // fall back to <main> so the first pass still finds something. The
      // MutationObserver will rescan once real content mounts.
      if (!out.length) {
        const main = document.querySelector("main");
        if (main) out.push(main);
      }
      return out;
    },
    skipSelectors: [
      "a.cm-card-link",
      "script",
      "style",
      "code",
      "pre",
      "textarea",
      "input",
      "button",
      "nav",
      "header",
      "footer",
      ".cm-hover-tooltip",
      // Moxfield decklist bits that are chrome, not prose
      ".mana-cost",
      ".card-row-price",
      ".dropdown-menu",
    ],
  });
})();
