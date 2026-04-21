// Reddit adapter. Supports both old.reddit.com and the modern shreddit DOM.
//
// We do NOT return document.body — reddit has too many short text nodes
// (usernames, flair, button labels, subreddit names) that would produce false
// positives. Instead we return a list of "body" containers: post text, self
// text, and comment bodies. New content from lazy-loaded comments and SPA
// navigation is picked up by the MutationObserver in content.js, which
// triggers a rescan — the rewriter is idempotent on already-tagged links.
(function () {
  const CM = (window.CM = window.CM || {});
  CM.adapters = CM.adapters || [];

  const ROOT_SELECTORS = [
    // --- Modern reddit (shreddit) ---
    // Post text body (self posts on a post page)
    'shreddit-post div[slot="text-body"]',
    // Comment bodies
    'shreddit-comment div[slot="comment"]',
    // Fallbacks that work across a couple of reddit iterations
    "shreddit-post .md",
    "shreddit-comment .md",

    // --- Old reddit ---
    // Self-post body + comment bodies both use .usertext-body .md
    ".usertext-body .md",

    // --- Reddit's older "new" design (pre-shreddit, still around in places) ---
    // Comment and post bodies have data-testid attributes.
    '[data-testid="comment"] .md',
    '[data-testid="post-container"] [data-click-id="text"] .md',
  ];

  CM.adapters.push({
    name: "reddit",
    host: /(^|\.)reddit\.com$/,
    root() {
      const nodes = document.querySelectorAll(ROOT_SELECTORS.join(","));
      return Array.from(nodes);
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
      "blockquote.cm-card-link", // paranoia
      ".cm-hover-tooltip",
      // Reddit-specific: avoid spoiler text covers and inline awards
      "[data-spoiler-text-hidden]",
    ],
  });
})();
