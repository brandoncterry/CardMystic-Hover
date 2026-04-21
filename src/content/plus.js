// "+" to clipboard button.
//
// Each tagged card link (`a.cm-card-link`) gets a sibling <button> that
// appends the card name to the system clipboard on click.
//
//   - Format is one bare card name per line (matches what decklist importers
//     expect for a plain list).
//   - Duplicates on the clipboard are detected and not re-appended; the
//     button does not animate in that case — a spin means "just wrote to
//     the clipboard". No write ↔ no spin.
//   - If the clipboard currently holds anything that isn't a pure card-name
//     list (any non-empty line isn't a known Scryfall card name), the
//     foreign contents are overwritten rather than appended to.
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

  function ensureFor(anchor, name) {
    if (!anchor || !name) return;
    const next = anchor.nextElementSibling;
    if (next && next.classList && next.classList.contains(BTN_CLASS)
        && next.dataset.cmCard === name) {
      if (addedNames.has(keyOf(name))) {
        next.classList.add("cm-card-plus--added");
      }
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.dataset.cmCard = name;
    btn.setAttribute("aria-label", `Add ${name} to clipboard`);
    btn.textContent = "+";
    // Copy the link's computed color so the "+" reads as part of the same
    // visual affordance on whatever palette the host page uses. Inline
    // style here; the --added class uses !important to win over it.
    try {
      const c = getComputedStyle(anchor).color;
      if (c) btn.style.color = c;
    } catch (_) { /* noop */ }
    anchor.after(btn);

    if (addedNames.has(keyOf(name))) {
      btn.classList.add("cm-card-plus--added");
    }
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
  // Clipboard reconciliation — the single source of truth
  // -----------------------------------------------------------------------

  function isKnownCardName(line) {
    if (!CM.cardNames || !CM.matcher) return false;
    return CM.cardNames.has(CM.matcher.normalize(line));
  }

  // Returns true if every non-empty line is a known card name. An empty
  // clipboard counts as a card list (trivially true — nothing violates).
  function clipboardIsCardList(text) {
    if (!text) return true;
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return true;
    for (const line of lines) {
      if (!isKnownCardName(line)) return false;
    }
    return true;
  }

  function parseCardKeys(text) {
    const keys = new Set();
    if (!text) return keys;
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      const k = keyOf(line);
      if (CM.cardNames && CM.cardNames.has(k)) keys.add(k);
    }
    return keys;
  }

  // Drive `addedNames` and every button's `--added` class from the current
  // clipboard text. This is the ONLY place addedNames and the purple class
  // are written — all other paths go through here.
  function reconcileClipboard(text) {
    // Foreign contents → clipboard holds nothing we recognize as added.
    const nextKeys = clipboardIsCardList(text) ? parseCardKeys(text) : new Set();

    // Replace addedNames atomically.
    addedNames.clear();
    for (const k of nextKeys) addedNames.add(k);

    // Sweep every existing "+" button once.
    const buttons = document.querySelectorAll("." + BTN_CLASS);
    for (const el of buttons) {
      const k = keyOf(el.dataset.cmCard || "");
      if (nextKeys.has(k)) el.classList.add("cm-card-plus--added");
      else el.classList.remove("cm-card-plus--added");
    }
  }

  // Read the clipboard and reconcile. Swallows read errors (permission /
  // focus issues) — if we can't see the clipboard, we leave the current
  // purple state alone rather than flashing it off.
  async function refreshFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      reconcileClipboard(text || "");
    } catch (_) {
      // No-op: can't read right now (no focus, denied permission, etc.)
    }
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

    // Bring UI state in line with what the clipboard ACTUALLY holds before
    // we decide what to do. This also covers external copies made between
    // the last focus/copy event and this click.
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
    if (!clipboardIsCardList(existing)) {
      const ok = await writeText(name);
      if (!ok) { markError(btn); return; }
      // Re-derive state from the NEW clipboard (just this name).
      reconcileClipboard(name);
      spin(btn);
      return;
    }

    // Already on the clipboard — reconcile already flipped the button
    // purple; no write, no spin.
    if (addedNames.has(keyOf(name))) {
      return;
    }

    // Fresh append.
    const base = (existing || "").trimEnd();
    const next = base ? `${base}\n${name}` : name;
    const ok = await writeText(next);
    if (!ok) { markError(btn); return; }
    reconcileClipboard(next);
    spin(btn);
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

  CM.plus = { ensureFor, install, BTN_CLASS };
})();
