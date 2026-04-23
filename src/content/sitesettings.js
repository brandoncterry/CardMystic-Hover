// Per-site detection settings (the two toggles that live at the top of
// the Cards on Page tab):
//
//   discover   — run the read-only card-name scan on this host. Without
//                this, Cards on Page stays empty.
//   hyperlinks — run the DOM-mutating rewriter: anchors, hover tooltips,
//                and the "+" buttons on every card name. Requires
//                discover to be on.
//
// Storage layout:
//   chrome.storage.local["fab:sites"] = {
//     [hostname]: { discover: boolean, hyperlinks: boolean },
//     ...
//   }
//
// When a hostname isn't in the map, defaults depend on whether any
// adapter registered in CM.adapters matches the host regex:
//   adapter match → { discover: true, hyperlinks: true }
//   no match      → { discover: false, hyperlinks: false }
// This keeps the adapter-supported sites (mtg.wiki, reddit, moxfield,
// edhrec) working day-one without the user having to opt in; explicit
// entries (including user-toggled-off states on adapter sites) always
// override the default.
//
// Public API (on window.CM.siteSettings):
//   init()                        load storage, wire cross-tab sync
//   get(hostname)                 resolved settings for that host
//   set(hostname, partial)        persist a partial update, dispatch event
//   hostnameIsAdapterMatched(h)   exported for debugging / UI
//
// Consumers listen for the `cm:sitesettingschanged` CustomEvent on
// `document`; event.detail is `{ hostname, next, prev }`.
(function () {
  const CM = (window.CM = window.CM || {});

  const KEY_SITES = "fab:sites";
  let sites = {};      // { hostname: { discover, hyperlinks } }
  let initialized = false;

  function defaultsFor(hostname) {
    const match = hostnameIsAdapterMatched(hostname);
    return { discover: match, hyperlinks: match };
  }

  function hostnameIsAdapterMatched(hostname) {
    if (!CM.adapters || !CM.adapters.length || !hostname) return false;
    for (const a of CM.adapters) {
      if (a && a.host && a.host.test && a.host.test(hostname)) return true;
    }
    return false;
  }

  function get(hostname) {
    const host = hostname || location.hostname;
    const stored = sites[host];
    if (stored && typeof stored.discover === "boolean" &&
        typeof stored.hyperlinks === "boolean") {
      return { discover: stored.discover, hyperlinks: stored.hyperlinks };
    }
    return defaultsFor(host);
  }

  function set(hostname, partial) {
    const host = hostname || location.hostname;
    const prev = get(host);
    const next = {
      discover: typeof partial.discover === "boolean"
        ? partial.discover : prev.discover,
      hyperlinks: typeof partial.hyperlinks === "boolean"
        ? partial.hyperlinks : prev.hyperlinks,
    };
    // Coherence: hyperlinks requires discover. If the caller flipped
    // discover off without touching hyperlinks, force hyperlinks off
    // too — we never want a (false, true) state persisted.
    if (!next.discover) next.hyperlinks = false;
    sites[host] = next;
    persist();
    dispatchChanged(host, prev, next);
  }

  function persist() {
    try {
      chrome.storage.local.set({ [KEY_SITES]: sites });
    } catch (err) {
      console.warn("[CardMystic] sitesettings persist failed", err);
    }
  }

  async function loadState() {
    try {
      const out = await chrome.storage.local.get(KEY_SITES);
      const v = out[KEY_SITES];
      if (v && typeof v === "object") sites = v;
    } catch (err) {
      console.warn("[CardMystic] sitesettings loadState failed", err);
    }
  }

  function watchStorage() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes[KEY_SITES]) return;
      const host = location.hostname;
      const prev = get(host);
      const v = changes[KEY_SITES].newValue;
      sites = v && typeof v === "object" ? v : {};
      const next = get(host);
      // Only dispatch if the current host's effective settings changed.
      if (prev.discover !== next.discover || prev.hyperlinks !== next.hyperlinks) {
        dispatchChanged(host, prev, next);
      }
    });
  }

  function dispatchChanged(hostname, prev, next) {
    try {
      document.dispatchEvent(new CustomEvent("cm:sitesettingschanged", {
        detail: { hostname, prev, next },
      }));
    } catch (_) { /* noop */ }
  }

  async function init() {
    if (initialized) return;
    await loadState();
    watchStorage();
    initialized = true;
    // Emit a boot-time event so consumers that registered late can do an
    // initial render off the resolved settings.
    const host = location.hostname;
    const cur = get(host);
    dispatchChanged(host, cur, cur);
  }

  CM.siteSettings = { init, get, set, hostnameIsAdapterMatched };
})();
