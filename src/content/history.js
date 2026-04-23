// Clipboard session tracking + history ring buffer.
//
// One "session" is a coherent card list the user is actively building. As
// long as the clipboard keeps evolving by small amounts (up to one net
// card added/removed per change), the current session grows/shrinks in
// place. The moment the clipboard jumps by more than one card or goes
// foreign (empty or not a recognizable decklist), the in-progress session
// is pushed to a history buffer capped at 10 entries.
//
// The FAB panel's "Clip History" tab renders `entries`; panel's "Clipped
// Cards" tab stays tied to the live clipboard (via plus.js). This module
// only owns the bookkeeping — no UI of its own.
//
// Public API exposed on window.CM.history:
//   init()           load from chrome.storage.local + subscribe to cross-tab changes
//   process(text)    canonical state-transition entry point; called from
//                    plus.js's reconcileClipboard after every mutation
//   get()            returns a plain snapshot { current, entries } for UI
//   restore(id)      writes a history entry's text back to the clipboard
//                    (delegates the round-trip through CM.plus.writeClipboard
//                    so the session break/reconcile flow happens naturally)
(function () {
  const CM = (window.CM = window.CM || {});

  const KEY_SESSION = "fab:session";
  const KEY_HISTORY = "fab:history";
  const MAX_ENTRIES = 10;

  // current: { text: string, cardKeys: string[], updatedAt: number } | null
  //   cardKeys stored as array in the persisted form (Sets don't serialize).
  //   Kept as Set in memory via deriveKeys() below for fast diff.
  let current = null;
  let entries = []; // newest first
  let initialized = false;

  function now() { return Date.now(); }

  function makeId() {
    return "cmh_" + Math.random().toString(36).slice(2, 10) + now().toString(36);
  }

  // Compute cardKeys Set from text via plus.js's parser. Falls through to
  // an empty Set if plus.js isn't loaded yet or the text isn't a decklist.
  function deriveKeys(text) {
    if (!CM.plus || !CM.plus.parseDeckList) return new Set();
    const parse = CM.plus.parseDeckList(text || "");
    return parse.isDeckList ? new Set(parse.cardKeys) : null;
    // null signals "not a decklist"; callers distinguish from "empty list".
  }

  // ----- persistence -----

  function snapshotForStorage() {
    return {
      [KEY_SESSION]: current
        ? {
            text: current.text,
            cardKeys: Array.from(current.cardKeys),
            updatedAt: current.updatedAt,
          }
        : null,
      [KEY_HISTORY]: entries,
    };
  }

  async function persist() {
    try {
      await chrome.storage.local.set(snapshotForStorage());
    } catch (err) {
      console.warn("[CardMystic] history persist failed", err);
    }
  }

  async function loadState() {
    try {
      const out = await chrome.storage.local.get([KEY_SESSION, KEY_HISTORY]);
      const s = out[KEY_SESSION];
      if (s && typeof s.text === "string") {
        current = {
          text: s.text,
          cardKeys: new Set(Array.isArray(s.cardKeys) ? s.cardKeys : []),
          updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : now(),
        };
      } else {
        current = null;
      }
      entries = Array.isArray(out[KEY_HISTORY]) ? out[KEY_HISTORY].slice(0, MAX_ENTRIES) : [];
    } catch (err) {
      console.warn("[CardMystic] history loadState failed", err);
    }
  }

  function watchStorage() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let changed = false;
      if (changes[KEY_SESSION]) {
        const s = changes[KEY_SESSION].newValue;
        if (s && typeof s.text === "string") {
          current = {
            text: s.text,
            cardKeys: new Set(Array.isArray(s.cardKeys) ? s.cardKeys : []),
            updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : now(),
          };
        } else {
          current = null;
        }
        changed = true;
      }
      if (changes[KEY_HISTORY]) {
        const v = changes[KEY_HISTORY].newValue;
        entries = Array.isArray(v) ? v.slice(0, MAX_ENTRIES) : [];
        changed = true;
      }
      if (changed) dispatchChanged();
    });
  }

  function dispatchChanged() {
    try {
      document.dispatchEvent(new CustomEvent("cm:historychanged"));
    } catch (_) { /* noop */ }
  }

  // ----- core transition -----

  // Deterministic signature for a set of normalized card keys — sorted and
  // joined, so two lists with the same cards but different order / format
  // / line counts compare equal.
  function signatureFromKeys(keysIterable) {
    const arr = Array.isArray(keysIterable)
      ? keysIterable.slice()
      : Array.from(keysIterable || []);
    arr.sort();
    return arr.join("|");
  }

  // Signature for an existing history entry by re-parsing its stored text
  // (we don't persist cardKeys on entries, so parse-on-demand). Returns
  // null when plus.js isn't available or the text isn't a decklist.
  function signatureForEntryText(text) {
    if (!CM.plus || !CM.plus.parseDeckList) return null;
    const parse = CM.plus.parseDeckList(text || "");
    if (!parse.isDeckList) return null;
    return signatureFromKeys(parse.cardKeys);
  }

  function pushCurrentToEntries() {
    if (!current || !current.text || current.cardKeys.size === 0) return;
    const sig = signatureFromKeys(current.cardKeys);
    // De-dupe: if any existing entry has the same card set (regardless of
    // order or format), drop it so the fresh push lands at the top as the
    // "most recent" occurrence. Prevents repeated copy/revert cycles from
    // filling the history with identical lists.
    if (sig) {
      entries = entries.filter((e) => signatureForEntryText(e.text) !== sig);
    }
    const entry = {
      id: makeId(),
      text: current.text,
      cardCount: current.cardKeys.size,
      createdAt: current.updatedAt || now(),
    };
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  }

  // Main entry point — called from plus.js after any clipboard mutation.
  // Keeps current + entries in sync with the text argument, which is the
  // authoritative clipboard content we just read or wrote.
  function process(text) {
    if (!initialized) return; // ignore events during boot
    const keys = deriveKeys(text);

    if (keys === null) {
      // Not a decklist. Close the current session and stop.
      if (current) {
        pushCurrentToEntries();
        current = null;
        persist();
        dispatchChanged();
      }
      return;
    }

    // keys is a Set (possibly empty — an empty but "decklist-valid" clipboard).
    // Empty clipboard: if nothing was tracked, nothing to do; if we WERE
    // tracking something, the last card was removed → treat as still the
    // same session until user continues or pivots. Empty set with no prev
    // is just noise, ignore.
    if (!current) {
      if (keys.size === 0) return; // no session, no cards — ignore.
      current = { text: text, cardKeys: keys, updatedAt: now() };
      persist();
      dispatchChanged();
      return;
    }

    const prev = current.cardKeys;
    let added = 0;
    let removed = 0;
    for (const k of keys) if (!prev.has(k)) added++;
    for (const k of prev) if (!keys.has(k)) removed++;
    const total = added + removed;

    if (total === 0) {
      // Same cards, maybe different formatting — sync text in place.
      if (text !== current.text) {
        current.text = text;
        current.updatedAt = now();
        persist();
        dispatchChanged();
      }
      return;
    }

    if (total > 1) {
      // Meaningful pivot. Archive the old session, start fresh.
      pushCurrentToEntries();
      current = { text: text, cardKeys: keys, updatedAt: now() };
      persist();
      dispatchChanged();
      return;
    }

    // Exactly one card added or removed — same session, just updated.
    current.text = text;
    current.cardKeys = keys;
    current.updatedAt = now();
    persist();
    dispatchChanged();
  }

  // ----- public API -----

  function get() {
    return {
      current: current
        ? {
            text: current.text,
            cardCount: current.cardKeys.size,
            updatedAt: current.updatedAt,
          }
        : null,
      entries: entries.slice(),
    };
  }

  async function restore(id) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return false;
    if (!CM.plus || !CM.plus.writeClipboard) return false;
    // writeClipboard runs reconcile → which calls history.process → which
    // will transition the current (if any) into entries and make this text
    // the new current session. So no manual bookkeeping needed here.
    return await CM.plus.writeClipboard(entry.text);
  }

  async function init() {
    if (initialized) return;
    await loadState();
    watchStorage();
    initialized = true;
    dispatchChanged();
  }

  CM.history = { init, process, get, restore };
})();
