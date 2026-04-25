// "+" to clipboard button.
//
// Each tagged card link (`a.cm-card-link`) gets a sibling <button> that
// appends the card name to the system clipboard on click.
//
//   - Append format matches the decklist format already on the clipboard:
//     Arena/MTGA (`1 Sol Ring`), Moxfield (`1x Sol Ring`), or bare name.
//     Detection is per-line via parseDeckLine — count prefixes, set codes
//     (`(OTP) 123`, `[OTP]`), collector numbers, and MTGO markers
//     (`*F*`, `*CMD*`) are all stripped so the extension recognizes
//     `3 Gix, Yawgmoth Praetor (TDC) 181` as containing Gix. Any line
//     that doesn't resolve to a known Scryfall card name (and isn't a
//     comment or a section header like "Deck"/"Sideboard") makes the
//     clipboard foreign and triggers an overwrite.
//   - Duplicates on the clipboard are detected and not re-appended; the
//     button does not animate in that case — a spin means "just wrote to
//     the clipboard". No write ↔ no spin. Duplicate detection is
//     format-agnostic: `3 Sol Ring` counts as Sol Ring being present.
//   - Visual state: bold "+" in the link color when the card is NOT on the
//     clipboard, purple when it IS. Colors are kept in sync with the real
//     clipboard contents — external copies (Ctrl+C in another app, manual
//     paste of a decklist, etc.) flip the buttons accordingly.
//   - The button carries `data-cm-card` so the existing hover delegation in
//     hover.js treats it as part of the card link — hovering from the link
//     to its "+" does not hide the preview tooltip.
(function () {
  const CM = (window.CM = window.CM || {});
  const BTN_CLASS = "cm-card-plus";
  const SPIN_MS = 400;
  const ERR_MS = 1200;

  // Normalized card keys currently on the clipboard, per our last read. This
  // is driven by reconcileClipboard() — never mutated directly by click
  // handlers. UI class `.cm-card-plus--added` is synced to membership here.
  const addedNames = new Set();

  function keyOf(name) {
    return CM.matcher ? CM.matcher.normalize(name) : (name || "").toLowerCase();
  }

  // -----------------------------------------------------------------------
  // Button creation
  // -----------------------------------------------------------------------

  // Reflect the "is this card currently on the clipboard?" state on a
  // single button: toggles the purple `--added` class, swaps the glyph
  // from "+" to "-", and updates the accessible label so screen readers
  // announce the correct action ("Add X" vs "Remove X").
  //
  // CRITICAL: every write here must be guarded by an equality check.
  // Unconditional `btn.textContent = "+"` replaces the button's text node
  // even when the value is identical, which is a childList mutation that
  // the rewriter's MutationObserver on document.body picks up. That would
  // re-trigger a scan → ensureFor → reflectAddedState → mutation, an
  // infinite loop. Idempotent writes break the cycle.
  function reflectAddedState(btn, isAdded) {
    if (!btn) return;
    const name = btn.dataset && btn.dataset.cmCard;

    const wantClass = !!isAdded;
    if (btn.classList.contains("cm-card-plus--added") !== wantClass) {
      btn.classList.toggle("cm-card-plus--added", wantClass);
    }

    const wantText = wantClass ? "\u00D7" : "+"; // × (cross) when removable
    if (btn.textContent !== wantText) {
      btn.textContent = wantText;
    }

    if (name) {
      const wantLabel = wantClass
        ? `Remove ${name} from clipboard`
        : `Add ${name} to clipboard`;
      if (btn.getAttribute("aria-label") !== wantLabel) {
        btn.setAttribute("aria-label", wantLabel);
      }
    }
  }

  function ensureFor(anchor, name) {
    if (!anchor || !name) return;
    const next = anchor.nextElementSibling;
    if (next && next.classList && next.classList.contains(BTN_CLASS)
        && next.dataset.cmCard === name) {
      reflectAddedState(next, addedNames.has(keyOf(name)));
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.dataset.cmCard = name;
    // Color is set by CSS (.cm-card-plus / --added / --err) so the glyph
    // reads as a hyperlink regardless of the host page's text palette.
    anchor.after(btn);
    // Sets glyph + aria-label + class consistent with current clipboard.
    reflectAddedState(btn, addedNames.has(keyOf(name)));
  }

  // -----------------------------------------------------------------------
  // UI feedback
  // -----------------------------------------------------------------------

  // Single 400 ms rotation. Remove-then-readd with a forced reflow so rapid
  // repeat clicks restart the animation cleanly.
  function spin(btn) {
    btn.classList.remove("cm-card-plus--spin");
    void btn.offsetWidth;
    btn.classList.add("cm-card-plus--spin");
    setTimeout(() => btn.classList.remove("cm-card-plus--spin"), SPIN_MS);
  }

  function markError(btn) {
    btn.classList.add("cm-card-plus--err");
    setTimeout(() => btn.classList.remove("cm-card-plus--err"), ERR_MS);
  }

  // -----------------------------------------------------------------------
  // "Ctrl+Shift+Space for Clipped Cards" toast
  // -----------------------------------------------------------------------
  //
  // Shown in the bottom-left corner after any successful write to the
  // clipboard — i.e. exactly when the user adds a new card. Duplicate
  // clicks don't re-trigger (nothing was written), write failures don't
  // trigger, and the toast auto-dismisses after a short delay. Repeated
  // additions within the window reset the dismiss timer so a streak of
  // clicks keeps the hint visible without restacking animations.

  const TOAST_MS = 2800;
  let toastEl = null;
  let toastDismissTimer = null;

  // Default hotkey-hint markup. Used when showToast is called with no
  // argument (the existing "+" click path).
  const DEFAULT_TOAST_HTML =
    '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>' +
    '<span class="cm-clip-toast__text"> for Clipped Cards</span>';

  function ensureToast() {
    if (toastEl && toastEl.isConnected) return toastEl;
    toastEl = document.createElement("div");
    toastEl.className = "cm-clip-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    // Content is set per-call in showToast; leave empty at creation.
    document.body.appendChild(toastEl);
    return toastEl;
  }

  // showToast() — default hotkey hint (existing callers).
  // showToast(html) — custom message; HTML is trusted (our own code).
  // showToast("Plain text") — also fine; plain text is valid innerHTML.
  function showToast(html) {
    const el = ensureToast();
    el.innerHTML = html == null ? DEFAULT_TOAST_HTML : String(html);
    el.classList.add("cm-clip-toast--visible");
    clearTimeout(toastDismissTimer);
    toastDismissTimer = setTimeout(() => {
      el.classList.remove("cm-clip-toast--visible");
    }, TOAST_MS);
  }

  // -----------------------------------------------------------------------
  // Decklist parser — recognizes Arena/MTGA, MTGO, Moxfield, Archidekt, and
  // bare-name formats, with or without count prefixes, set codes, collector
  // numbers, foil markers, and section headers.
  // -----------------------------------------------------------------------

  // Resolve any user-written card name (bare, split/DFC variant, one face
  // only) to its canonical normalized Scryfall key, or null if unknown.
  //
  //   1. Direct hit in the catalog.
  //   2. Slash normalization — Scryfall canonical uses " // " between faces;
  //      users often write " / ", "//", or "/". Collapse any run of slashes
  //      with optional surrounding whitespace to " // " and retry. Safe
  //      because no real card name contains a bare "/".
  //   3. Face-name fallback via CM.cardFaces (e.g. "Delver of Secrets" →
  //      "Delver of Secrets // Insectile Aberration"). Built in content.js.
  function resolveCardKey(name) {
    if (!CM.cardNames || !CM.matcher) return null;
    const key = CM.matcher.normalize(name);
    if (CM.cardNames.has(key)) return key;

    const slashed = key.replace(/\s*\/+\s*/g, " // ");
    if (slashed !== key && CM.cardNames.has(slashed)) return slashed;

    if (CM.cardFaces) {
      const faceHit = CM.cardFaces.get(key);
      if (faceHit) return faceHit;
      if (slashed !== key) {
        const faceSlashedHit = CM.cardFaces.get(slashed);
        if (faceSlashedHit) return faceSlashedHit;
      }
    }

    return null;
  }

  function lookupCard(name) {
    return resolveCardKey(name);
  }

  // Headers we accept so their presence doesn't disqualify the decklist.
  const SECTION_WORDS = /^(deck|sideboard|maybeboard|commander|companion|tokens)\s*:?\s*$/i;

  // Strip trailing Arena `(SET) 123`, Moxfield `[SET]`, and MTGO `*F*`/`*CMD*`
  // markers iteratively so a line carrying several of them reduces to the
  // bare card name. Run until no suffix matches.
  function stripRightDecorations(s) {
    const patterns = [
      /\s*\([A-Za-z0-9]+\)(\s+\d+)?\s*$/,  // (SET) or (SET) 123
      /\s*\[[A-Za-z0-9]+\]\s*$/,           // [SET]
      /\s*\*[A-Za-z]+\*\s*$/,              // *F* / *CMD* / *Foil*
    ];
    let prev;
    do {
      prev = s;
      for (const re of patterns) s = s.replace(re, "");
    } while (s !== prev);
    return s.trim();
  }

  // Parse one line into { kind, ... }. See plan for kind schema.
  function parseDeckLine(raw) {
    if (raw == null) return { kind: "empty" };
    const trimmed = String(raw).trim();
    if (!trimmed) return { kind: "empty" };

    // Try stripping a left-side decorator stack: optional `SB:`, optional
    // count-with-optional-x.
    let rest = trimmed;
    let prefix = "";       // what we'd re-emit when appending in this style
    let sideboard = false; // just for header disambiguation of bare "SB:"

    const sbMatch = rest.match(/^SB:\s*/i);
    if (sbMatch) {
      sideboard = true;
      rest = rest.slice(sbMatch[0].length);
    }

    const countMatch = rest.match(/^(\d+)(x)?\s+/i);
    if (countMatch) {
      prefix = countMatch[2] ? "1x " : "1 ";
      rest = rest.slice(countMatch[0].length);
    }

    // Right-side: strip set codes, collector numbers, foil markers.
    const stripped = stripRightDecorations(rest);

    // Try the stripped form first, then the un-stripped remainder (handles
    // names that legitimately contain parens/brackets, e.g. tokens).
    let key = lookupCard(stripped);
    let cardName = stripped;
    if (!key) {
      key = lookupCard(rest);
      cardName = rest;
    }
    if (key) {
      return { kind: "card", cardKey: key, cardName, prefix };
    }

    // Not a card. Check if it's a recognized header or comment.
    if (/^(\/\/|#)/.test(trimmed)) return { kind: "header", raw: trimmed };
    if (SECTION_WORDS.test(trimmed)) return { kind: "header", raw: trimmed };
    if (sideboard && !rest) return { kind: "header", raw: trimmed };

    return { kind: "unknown", raw: trimmed };
  }

  // Classify the full clipboard. Any `unknown` line disqualifies.
  function parseDeckList(text) {
    const out = {
      isDeckList: true,
      cardKeys: new Set(),
      format: { countStyle: "" },
    };
    if (!text) return out;
    const lines = text.split(/\r?\n/);
    let firstCardPrefix = null;
    for (const raw of lines) {
      const parsed = parseDeckLine(raw);
      if (parsed.kind === "unknown") {
        out.isDeckList = false;
        out.cardKeys.clear();
        out.format.countStyle = "";
        return out;
      }
      if (parsed.kind === "card") {
        out.cardKeys.add(parsed.cardKey);
        if (firstCardPrefix == null) firstCardPrefix = parsed.prefix;
      }
    }
    if (firstCardPrefix != null) out.format.countStyle = firstCardPrefix;
    return out;
  }

  // -----------------------------------------------------------------------
  // Clipboard reconciliation — the single source of truth
  // -----------------------------------------------------------------------

  // Drive `addedNames` and every button's `--added` class from the current
  // clipboard text. This is the ONLY place addedNames and the purple class
  // are written — all other paths go through here. Also the canonical
  // entry point for the history state machine; see CM.history.process.
  function reconcileClipboard(text) {
    const parse = parseDeckList(text || "");
    // Foreign contents → clipboard holds nothing we recognize as added.
    const nextKeys = parse.isDeckList ? parse.cardKeys : new Set();

    addedNames.clear();
    for (const k of nextKeys) addedNames.add(k);

    const buttons = document.querySelectorAll("." + BTN_CLASS);
    for (const el of buttons) {
      const k = keyOf(el.dataset.cmCard || "");
      reflectAddedState(el, nextKeys.has(k));
    }

    // Session + history bookkeeping. history.process is a no-op before
    // CM.history.init() resolves, so the ordering during boot is safe.
    if (CM.history && CM.history.process) {
      CM.history.process(text || "");
    }
  }

  // Read the clipboard and reconcile. Swallows read errors (permission /
  // focus issues) — if we can't see the clipboard, we leave the current
  // purple state alone rather than flashing it off.
  async function refreshFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      reconcileClipboard(text || "");
      dispatchClipChange();
    } catch (_) {
      // No-op: can't read right now (no focus, denied permission, etc.)
    }
  }

  // Notify other modules in the same content-script world (e.g. the FAB
  // panel) that the clipboard has changed and any cached view of it should
  // be re-rendered. Cheap CustomEvent on document — listeners filter by
  // panelOpen / visibility themselves.
  function dispatchClipChange() {
    try {
      document.dispatchEvent(new CustomEvent("cm:clipboardchanged"));
    } catch (_) { /* noop */ }
  }

  // Empty the clipboard entirely. Used by the right-click "Clear
  // CardMystic clipboard" menu item (the service worker injects this
  // call into the active tab's content-script world). Runs the full
  // reconcile + history transition: the just-cleared list gets archived
  // to Clip History because reconcileClipboard("") → CM.history.process("")
  // flips the session to a >1 delta for any list longer than one card.
  // Also surfaces a toast with the cleared count.
  async function clearClipboard() {
    let existing = "";
    try { existing = await navigator.clipboard.readText(); } catch (_) {}
    const parse = parseDeckList(existing);
    const count = parse.isDeckList ? parse.cardKeys.size : 0;

    try {
      await navigator.clipboard.writeText("");
    } catch (err) {
      console.warn("[CardMystic] clearClipboard write failed", err);
      return false;
    }
    reconcileClipboard("");
    dispatchClipChange();

    if (count > 0) {
      showToast(
        "Cleared \u2014 " + count + " card" + (count === 1 ? "" : "s") +
          " moved to history"
      );
    } else {
      showToast("Clipboard cleared");
    }
    return true;
  }

  // Exposed helper used by the FAB panel's per-line remove button. Writes
  // the given text to the clipboard, reconciles the button states, and
  // fires the change event so any open panel re-renders. Centralizes the
  // write path so all mutations flow through the same bookkeeping.
  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      reconcileClipboard(text);
      dispatchClipChange();
      return true;
    } catch (err) {
      console.warn("[CardMystic] clipboard write failed", err);
      return false;
    }
  }

  // Exposed helper for the FAB panel's "Cards on Page" tab. Finds the first
  // matching in-page "+" button for the given card name and clicks it
  // programmatically — which reuses the full existing click flow (spin,
  // toast, format-aware append, reconcile, history). If no in-page button
  // exists yet (e.g. the anchor was removed by a site SPA), we fall back
  // to a direct append via writeClipboard.
  async function clipCard(name) {
    if (!name) return false;
    try {
      const selector = `a.${LINK_CLASS}[data-cm-card="${CSS.escape(name)}"]`;
      const anchor = document.querySelector(selector);
      if (anchor) {
        const sib = anchor.nextElementSibling;
        if (sib && sib.classList && sib.classList.contains(BTN_CLASS)) {
          sib.click();
          return true;
        }
      }
    } catch (err) {
      console.warn("[CardMystic] clipCard anchor lookup failed", err);
    }
    // Fallback: toggle directly against the clipboard. Mirrors the
    // in-page onPlusClick semantics so the panel's proxy still does the
    // right thing if the in-page anchor was stripped by an SPA between
    // render and click.
    let existing = "";
    try { existing = await navigator.clipboard.readText(); } catch (_) {}
    const parse = parseDeckList(existing);
    const targetKey = keyOf(name);

    if (!parse.isDeckList) return await writeClipboard(name);

    if (parse.cardKeys.has(targetKey)) {
      const rawLines = existing.split(/\r?\n/);
      const kept = [];
      for (const raw of rawLines) {
        const parsedLine = parseDeckLine(raw);
        if (parsedLine.kind === "card" && parsedLine.cardKey === targetKey) continue;
        kept.push(raw);
      }
      while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
      return await writeClipboard(kept.join("\n"));
    }

    const base = (existing || "").trimEnd();
    const joiner = base ? "\n" : "";
    const next = `${base}${joiner}${parse.format.countStyle}${name}`;
    return await writeClipboard(next);
  }

  // -----------------------------------------------------------------------
  // Click flow
  // -----------------------------------------------------------------------

  async function onPlusClick(btn) {
    const name = btn.dataset.cmCard;
    if (!name) return;

    let existing = "";
    try {
      existing = await navigator.clipboard.readText();
    } catch (_) {
      existing = "";
    }

    // Single parse reused for decide-what-to-do + UI reconcile. Parsing
    // handles Arena (`1 Card (SET) 123`), Moxfield (`1x Card`), MTGO
    // (`1 Card *F*`), bare names, and section headers.
    const parse = parseDeckList(existing);

    // Bring UI state in line with what the clipboard ACTUALLY holds before
    // we decide what to do. Covers external copies since the last event.
    reconcileClipboard(existing);

    const writeText = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        console.warn("[CardMystic] clipboard write failed", err);
        return false;
      }
    };

    // Foreign clipboard contents — overwrite entirely with just this name.
    if (!parse.isDeckList) {
      const ok = await writeText(name);
      if (!ok) { markError(btn); return; }
      reconcileClipboard(name);
      dispatchClipChange();
      spin(btn);
      showToast();
      return;
    }

    // Already on the clipboard — button is in its "-" / removal state.
    // Drop every line whose parsed card key matches (handles Arena format,
    // Moxfield counts, MTGO markers, split-card variants). No toast on
    // remove (reserved for additive actions); spin still fires for tactile
    // feedback.
    if (parse.cardKeys.has(keyOf(name))) {
      const target = keyOf(name);
      const rawLines = (existing || "").split(/\r?\n/);
      const kept = [];
      for (const raw of rawLines) {
        const parsedLine = parseDeckLine(raw);
        if (parsedLine.kind === "card" && parsedLine.cardKey === target) continue;
        kept.push(raw);
      }
      // Trim any trailing blank lines left behind by the removal.
      while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
      const next = kept.join("\n");
      const ok = await writeText(next);
      if (!ok) { markError(btn); return; }
      reconcileClipboard(next);
      dispatchClipChange();
      spin(btn);
      return;
    }

    // Fresh append, matching the detected format so we don't mix styles
    // within one decklist.
    const base = (existing || "").trimEnd();
    const joiner = base ? "\n" : "";
    const next = `${base}${joiner}${parse.format.countStyle}${name}`;
    const ok = await writeText(next);
    if (!ok) { markError(btn); return; }
    reconcileClipboard(next);
    dispatchClipChange();
    spin(btn);
    showToast();
  }

  // -----------------------------------------------------------------------
  // Install
  // -----------------------------------------------------------------------

  function install() {
    // Click delegation — capture-phase so we beat host-site handlers.
    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target.closest && e.target.closest("." + BTN_CLASS);
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        onPlusClick(btn);
      },
      true
    );

    // Keyboard activation — native <button> fires click on Space/Enter, but
    // some hosts swallow those events. Explicit handler keeps us safe.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const btn = e.target.closest && e.target.closest("." + BTN_CLASS);
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        onPlusClick(btn);
      },
      true
    );

    // ---- Keep button colors in sync with the real clipboard ----

    // Tab regains focus after the user was elsewhere (copied something in
    // another app / tab, etc.).
    window.addEventListener("focus", refreshFromClipboard);

    // Tab becomes visible (covers page switches within the same window
    // where `focus` may not fire on some platforms).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshFromClipboard();
    });

    // In-page copy/cut — refresh after the clipboard has settled. Using
    // setTimeout(0) rather than reading inside the event handler because
    // the clipboard isn't guaranteed to be updated synchronously.
    const onCopyLike = () => setTimeout(refreshFromClipboard, 0);
    document.addEventListener("copy", onCopyLike, true);
    document.addEventListener("cut", onCopyLike, true);

    // First paint: read once so any existing clipboard state is reflected
    // immediately. Harmless if it fails (we retry on any of the above
    // events — most commonly the user's first click).
    refreshFromClipboard();
  }

  CM.plus = {
    ensureFor,
    install,
    BTN_CLASS,
    parseDeckList,
    keyOf,
    writeClipboard,
    clipCard,
    clearClipboard,
  };
})();
