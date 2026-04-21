# CardMystic Hover

A cross-browser web extension (Chrome MV3 + Firefox) that finds Magic: The Gathering card names on supported pages, links them to [CardMystic](https://cardmystic.com), and shows a card image preview on hover.

First supported site: **mtg.wiki**. Adding more sites is a one-file change under `src/sites/`.

## How it works

1. A background service worker fetches Scryfall's card-names catalog once (cached 7 days in `chrome.storage.local`) and looks up individual cards on demand (cached 30 days).
2. A content script builds a trie from the catalog and walks the article DOM, turning card-name text into `<a class="cm-card-link" data-cm-card="...">`. Pre-existing anchors whose text is exactly a card name are overridden in place — the original `href` is preserved on `data-cm-original-href`.
3. Links initially point to a Scryfall search URL; the background resolves each name to its Scryfall UUID and upgrades the `href` to `https://cardmystic.com/card/<uuid>`.
4. Hovering a tagged link shows a floating image preview positioned above (or below, if near the top edge) the link.

## Loading the extension

### Chrome / Edge / Brave
1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this repo folder.
4. Visit `https://mtg.wiki/page/Lightning_Bolt` — prose mentions of card names should become dotted-underline links with a hover preview.

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json`.
3. Same test as above.

## Project layout

```
manifest.json
src/
  background/
    service-worker.js   # message router
    scryfall.js         # API client, rate limit, in-flight dedupe
    cache.js            # chrome.storage.local TTL wrapper
  content/
    content.js          # entry: pick adapter, fetch catalog, scan, observe
    matcher.js          # trie + longest-match scanner
    rewriter.js         # text-node replacement + anchor override
    hover.js            # tooltip element, hover handlers, positioning
    hover.css
  sites/
    index.js            # hostname -> adapter picker
    mtgwiki.js          # mtg.wiki root + skip selectors
assets/
  icon-16.png icon-48.png icon-128.png   (add your own)
```

## Adding a new site

Create `src/sites/yoursite.js` that pushes an adapter onto `window.CM.adapters`:

```js
(function () {
  const CM = (window.CM = window.CM || {});
  CM.adapters = CM.adapters || [];
  CM.adapters.push({
    name: "yoursite",
    host: /(^|\.)yoursite\.com$/,
    root: () => document.querySelector("main") || document.body,
    skipSelectors: ["a.cm-card-link", "script", "style", "code", "pre", ".cm-hover-tooltip"],
  });
})();
```

Then add it to `manifest.json` under `content_scripts[0].matches` and `content_scripts[0].js` (before `src/sites/index.js`).

## Icons

The extension expects `assets/icon-16.png`, `icon-48.png`, and `icon-128.png`. Drop any PNGs with those dimensions into `assets/` before packaging.
