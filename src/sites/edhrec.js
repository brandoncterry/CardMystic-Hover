// EDHREC site adapter.
//
// Covers article pages under edhrec.com/articles/*. EDHREC's article card
// links look like this:
//
//   <span class="edhrecp__link">
//     <span class="d-none d-md-inline">     <!-- desktop -->
//       <a class="edhrecp__link-a" content="Card Name"
//          href="/cards/card-slug" target="_blank">Card Name</a>
//       ...React-managed hover preview mounts here on mouseenter...
//     </span>
//     <span class="d-inline d-md-none">     <!-- mobile, hidden on desktop -->
//       <span class="fake-link">Card Name</span>
//     </span>
//   </span>
//
// The hover preview is **React-driven**: an `onMouseEnter` handler is
// attached to the desktop span. When fired, React fetches card data from
// `https://json.edhrec.com/cards/{slug}` and mounts a
// `<span class="CardHover_hover__OdEVj">` (CSS-module hashed suffix) at
// z-index 4001. On mouseleave React unmounts it.
//
// Important: React's event system uses **synthetic events keyed off the
// internal fiber tree**, not CSS selectors. Removing the `edhrecp__link-a`
// class from the anchor, or stripping parent class names, does NOT stop the
// hover handler from firing — React dispatches to its fiber, not the DOM.
//
// The reliable fix is to hide the React-rendered hover element with CSS.
// The fetch to json.edhrec.com still happens on mouseenter (wasted work,
// invisible to us) but the popup element is never visible to the user.
// That leaves our CardMystic tooltip as the only visible preview.
(function () {
  const CM = (window.CM = window.CM || {});
  CM.adapters = CM.adapters || [];

  CM.adapters.push({
    name: "edhrec",
    host: /(^|\.)edhrec\.com$/,
    root() {
      if (!/^\/articles(\/|$)/.test(location.pathname)) return null;
      return (
        document.querySelector("main article") ||
        document.querySelector("article") ||
        document.querySelector("main") ||
        null
      );
    },
    // Injected at boot — hides the React-mounted hover popup and the mobile
    // fullscreen viewer. CSS-module class names are hashed (e.g.
    // `CardHover_hover__OdEVj`), so we use attribute substring selectors to
    // survive rebuilds.
    styles: `
      [class*="CardHover_hover"],
      [class*="CardHover_mobileViewer"] {
        display: none !important;
      }
    `,
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
      // EDHREC-specific subtrees we should never scan
      ".edhrecp__link-image",
      ".edhrecp__card-container",
      // Mobile-only span — hidden on desktop via Bootstrap utility classes,
      // but we still skip it so we never rewrite the inner `fake-link` text
      // into a second link.
      ".d-inline.d-md-none",
      '[class*="CardHover_hover"]',
      '[class*="CardHover_mobileViewer"]',
    ],
    // Cosmetic cleanup on override — not strictly necessary since React
    // doesn't care about these, but it keeps the DOM tidy so a future dev
    // tools inspection isn't confusing.
    overrideStrip: {
      classes: ["edhrecp__link-a"],
      attrs: ["content"],
    },
  });
})();
