// Walks a root element and rewrites card name occurrences into links that
// point to CardMystic. There are two modes:
//
//   1. Plain text node — split the node and wrap the matched substring in a
//      fresh <a class="cm-card-link" data-cm-card="...">.
//   2. Existing <a> whose trimmed text is exactly a card name — override the
//      anchor in place (swap href, tag it, stash the original href). We cannot
//      nest anchors, so this is the only legal way to "place our link over"
//      an existing one.
//
// Links start with a placeholder href (scryfall search) and are upgraded to
// https://cardmystic.com/card/<uuid> once the background worker resolves the
// name. The rewriter keeps an index of pending links per lowercased name so
// the resolver can patch every copy at once.
(function () {
  const CM = (window.CM = window.CM || {});
  const LINK_CLASS = "cm-card-link";

  const pending = new Map(); // lowercased name -> Array<HTMLAnchorElement>
  const resolved = new Map(); // lowercased name -> { id, name } | { notFound: true }

  function placeholderHref(name) {
    return `https://scryfall.com/search?q=${encodeURIComponent('!"' + name + '"')}`;
  }

  function cardMysticHref(id) {
    return `https://cardmystic.com/card/${id}`;
  }

  function isSkipped(node, skipSelectors) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      for (const sel of skipSelectors) {
        if (el.matches && el.matches(sel)) return true;
      }
    }
    return false;
  }

  function hasAnchorAncestor(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (el.tagName === "A") return el;
    }
    return null;
  }

  function makeAnchor(name) {
    const a = document.createElement("a");
    a.className = LINK_CLASS;
    a.dataset.cmCard = name;
    a.href = placeholderHref(name);
    a.textContent = name;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    registerPending(name, a);
    return a;
  }

  function registerPending(name, anchor) {
    const key = CM.matcher.normalize(name);
    const existing = resolved.get(key);
    if (existing && !existing.notFound && existing.id) {
      anchor.href = cardMysticHref(existing.id);
      return;
    }
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push(anchor);
    resolveName(name, key);
  }

  function resolveName(name, key) {
    if (resolved.has(key)) return; // already cached or in-flight
    resolved.set(key, { pendingFetch: true });
    chrome.runtime.sendMessage({ type: "getCard", name }, (resp) => {
      if (!resp || !resp.ok) {
        resolved.set(key, { notFound: true });
        return;
      }
      const data = resp.data;
      resolved.set(key, data);
      if (data && data.id) {
        const href = cardMysticHref(data.id);
        const list = pending.get(key) || [];
        for (const a of list) a.href = href;
      }
      pending.delete(key);
    });
  }

  // Inline event handler attributes we want stripped when we take over an anchor.
  const INLINE_EVENT_ATTRS = [
    "onclick", "onmouseover", "onmouseout", "onmouseenter", "onmouseleave",
    "onmousemove", "onfocus", "onblur", "ontouchstart", "ontouchend",
  ];

  // Replace an element with a clone of itself. Clones do not carry event
  // listeners added via addEventListener, so this is the cleanest way to
  // strip a host site's hover/tooltip handlers from a link we're about to
  // override. Returns the fresh (cloned) element so the caller can keep
  // working with it.
  function stripListeners(el) {
    const clone = el.cloneNode(true);
    for (const attr of INLINE_EVENT_ATTRS) {
      if (clone.hasAttribute(attr)) clone.removeAttribute(attr);
    }
    el.replaceWith(clone);
    return clone;
  }

  // Strip site-specific markers that the host site uses to identify its
  // "card" anchors for delegated hover/click handlers. We do this BEFORE
  // cloning so that if any handler is still keyed off the original reference,
  // it sees a neutralized node.
  function applyOverrideStrip(el, overrideStrip) {
    if (!overrideStrip) return;
    if (overrideStrip.classes) {
      for (const c of overrideStrip.classes) el.classList.remove(c);
    }
    if (overrideStrip.attrs) {
      for (const a of overrideStrip.attrs) {
        if (el.hasAttribute(a)) el.removeAttribute(a);
      }
    }
  }

  // --- Anchor override pass ---
  function overrideAnchors(root, trie, adapter) {
    const skipSelectors = adapter.skipSelectors || [];
    const overrideStrip = adapter.overrideStrip;
    const anchors = root.querySelectorAll("a");
    for (const a of anchors) {
      if (a.classList.contains(LINK_CLASS)) continue;
      if (isSkipped(a, skipSelectors)) continue;
      const text = (a.textContent || "").trim();
      if (!text || text.length > 80) continue;
      // Must be exactly one card name from start to end.
      const norm = CM.matcher.normalize(text);
      const matches = CM.matcher.findAll(trie, text);
      if (matches.length !== 1) continue;
      const m = matches[0];
      if (m.start !== 0 || m.end !== norm.length) continue;

      // Strip the host site's identifying classes/attrs first so any
      // delegated hover handlers keyed on those selectors stop matching.
      applyOverrideStrip(a, overrideStrip);

      // Replace the anchor with a clean clone so any per-element listeners
      // the host site attached are discarded as well. Then override in place.
      const fresh = stripListeners(a);

      fresh.classList.add(LINK_CLASS);
      if (fresh.href && !fresh.dataset.cmOriginalHref) {
        fresh.dataset.cmOriginalHref = fresh.href;
      }
      fresh.dataset.cmCard = m.name;
      fresh.href = placeholderHref(m.name);
      // Always open CardMystic in a new tab so the user doesn't lose their
      // place on the host page.
      fresh.target = "_blank";
      fresh.rel = "noopener noreferrer";
      // Many MediaWiki/card-preview gadgets use `title` to trigger native
      // browser tooltips or to key off for their hover logic. Drop it.
      if (fresh.hasAttribute("title")) fresh.removeAttribute("title");

      // Let the adapter neutralize anything on the parent/siblings that the
      // host site uses for delegated hover handlers. Any errors here are
      // non-fatal — we don't want an adapter bug to break the whole pass.
      if (typeof adapter.postOverride === "function") {
        try { adapter.postOverride(fresh); }
        catch (err) { console.warn("[CardMystic] postOverride failed", err); }
      }

      registerPending(m.name, fresh);
      // `fresh` is in the live DOM (stripListeners replaced the original
      // anchor in-place), so .after() is safe here.
      if (CM.plus && CM.plus.ensureFor) CM.plus.ensureFor(fresh, m.name);
    }
  }

  // --- Text node rewrite pass ---
  function rewriteTextNodes(root, trie, skipSelectors) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 3) return NodeFilter.FILTER_REJECT;
        if (hasAnchorAncestor(node)) return NodeFilter.FILTER_REJECT;
        if (isSkipped(node, skipSelectors)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);

    for (const textNode of targets) {
      const text = textNode.nodeValue;
      const matches = CM.matcher.findAll(trie, text);
      if (!matches.length) continue;

      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const m of matches) {
        if (m.start > cursor) {
          frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
        }
        // Use the slice of the ORIGINAL text so we keep the user-visible casing.
        const visible = text.slice(m.start, m.end);
        const a = makeAnchor(m.name);
        a.textContent = visible;
        frag.appendChild(a);
        // Now that the anchor has a parent (the fragment), anchor.after()
        // works. This inserts the "+" button as a sibling within the frag.
        if (CM.plus && CM.plus.ensureFor) CM.plus.ensureFor(a, m.name);
        cursor = m.end;
      }
      if (cursor < text.length) {
        frag.appendChild(document.createTextNode(text.slice(cursor)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  // Safety pass: walk every tagged anchor under `root` and make sure each
  // has its sibling "+" button. Covers cases where a host site mutated our
  // DOM between passes, or where anchors predate the plus feature from a
  // previous version of the extension.
  function ensurePlusButtons(root) {
    if (!CM.plus || !CM.plus.ensureFor) return;
    const anchors = root.querySelectorAll("a." + LINK_CLASS);
    for (const a of anchors) {
      const name = a.dataset.cmCard;
      if (!name) continue;
      CM.plus.ensureFor(a, name);
    }
  }

  // Subtrees we always skip, regardless of per-adapter configuration. These
  // are elements the extension itself owns; scanning inside them would lead
  // to infinite idempotency loops or turn our own UI into card links.
  const BUILT_IN_SKIP = [
    "a.cm-card-link",
    "button.cm-card-plus",
    ".cm-hover-tooltip",
  ];

  function rewrite(root, trie, adapter) {
    if (!root || !trie || !adapter) return;
    const skips = BUILT_IN_SKIP.concat(adapter.skipSelectors || []);
    const effectiveAdapter = Object.assign({}, adapter, { skipSelectors: skips });
    overrideAnchors(root, trie, effectiveAdapter);
    rewriteTextNodes(root, trie, skips);
    ensurePlusButtons(root);
  }

  // --- Read-only scan ---
  //
  // Walks the same text nodes rewriteTextNodes would, but just records
  // canonical card keys in a Set. Does NOT touch the DOM. Used by
  // content.js's "detect" mode so the Cards on Page tab can list
  // detected cards without injecting anchors/+/hover.
  function collect(root, trie, adapter) {
    const out = new Set();
    if (!root || !trie) return out;
    const skipSelectors = BUILT_IN_SKIP.concat((adapter && adapter.skipSelectors) || []);
    // Also collect keys from any existing overridden anchors — on adapter
    // sites the page may already carry resolvable card links even before
    // we scan text nodes.
    if (root.querySelectorAll) {
      const anchors = root.querySelectorAll("a");
      for (const a of anchors) {
        if (isSkipped(a, skipSelectors)) continue;
        const text = (a.textContent || "").trim();
        if (!text || text.length > 80) continue;
        const norm = CM.matcher.normalize(text);
        const matches = CM.matcher.findAll(trie, text);
        if (matches.length !== 1) continue;
        const m = matches[0];
        if (m.start !== 0 || m.end !== norm.length) continue;
        out.add(CM.matcher.normalize(m.name));
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 3) return NodeFilter.FILTER_REJECT;
        if (hasAnchorAncestor(node)) return NodeFilter.FILTER_REJECT;
        if (isSkipped(node, skipSelectors)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const matches = CM.matcher.findAll(trie, n.nodeValue);
      for (const m of matches) out.add(CM.matcher.normalize(m.name));
    }
    return out;
  }

  // --- Reverse of rewrite ---
  //
  // Removes every DOM change the rewriter previously made under `root`:
  //   - Anchors we CREATED (no data-cm-original-href) collapse back to a
  //     plain text node with the original visible casing.
  //   - Anchors we TOOK OVER (have data-cm-original-href) get their href
  //     restored and our classes/data stripped; element stays in place.
  //   - All sibling "+" buttons for our links are removed.
  //   - Adapter styles we injected (style[data-cm-adapter]) are removed.
  // Idempotent: a re-call with nothing to undo is a no-op.
  function unrewrite(root) {
    const scope = root || document;

    // Pass 1: every tagged anchor.
    const anchors = scope.querySelectorAll("a." + LINK_CLASS);
    for (const a of anchors) {
      const sib = a.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains("cm-card-plus")) {
        sib.remove();
      }
      if (a.hasAttribute("data-cm-original-href")) {
        // Overridden anchor — restore original href and shed markers.
        const orig = a.getAttribute("data-cm-original-href");
        if (orig) a.setAttribute("href", orig);
        a.classList.remove(LINK_CLASS);
        a.removeAttribute("data-cm-card");
        a.removeAttribute("data-cm-original-href");
        // target/rel were set by us; if no original target existed we
        // leave target alone (safer than guessing). Same for rel.
      } else {
        // Anchor we created — replace with plain text.
        const text = document.createTextNode(a.textContent || "");
        a.replaceWith(text);
      }
    }

    // Pass 2: orphan "+" buttons (anchor was removed by some other
    // code path, or we failed to find a sibling above).
    const orphanPlus = scope.querySelectorAll("button.cm-card-plus");
    for (const b of orphanPlus) b.remove();

    // Pass 3: injected adapter-style tags (found on document.head, not
    // necessarily under `root`).
    const styles = document.querySelectorAll("style[data-cm-adapter]");
    for (const s of styles) s.remove();
  }

  CM.rewriter = { rewrite, collect, unrewrite, LINK_CLASS };
})();
