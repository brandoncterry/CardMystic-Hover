// mtg.wiki site adapter. Tells the scanner where article content lives and
// which subtrees to leave alone.
(function () {
  const CM = (window.CM = window.CM || {});
  CM.adapters = CM.adapters || [];

  CM.adapters.push({
    name: "mtgwiki",
    host: /(^|\.)mtg\.wiki$/,
    root() {
      return (
        document.querySelector("#mw-content-text .mw-parser-output") ||
        document.querySelector("#mw-content-text") ||
        document.body
      );
    },
    // Ancestors of text nodes that should be skipped entirely.
    skipSelectors: [
      "a.cm-card-link",
      "script",
      "style",
      "code",
      "pre",
      "textarea",
      "input",
      ".mw-editsection",
      ".toc",
      ".cm-hover-tooltip",
    ],
    // When we override an existing anchor, also strip these identifying
    // classes and data attributes. mtg.wiki ships a MediaWiki extension that
    // attaches its own Scryfall hover tooltip via event delegation on
    // `.ext-scryfall-cardname` + `data-card-name` — cloning the anchor does
    // not strip delegated handlers, but removing the selector they key off
    // does.
    overrideStrip: {
      classes: ["ext-scryfall-cardname"],
      attrs: ["data-card-name"],
    },
  });
})();
