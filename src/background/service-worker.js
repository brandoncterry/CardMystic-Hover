// Background message router. Content scripts talk to this via chrome.runtime.sendMessage.
//
// Supported messages:
//   { type: "getCardNames" }            -> string[]
//   { type: "getCard", name: "..." }    -> { id, name, image, faces } | { notFound: true }

import { getCardNames, getCardByName } from "./scryfall.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String(err && err.message || err) })
  );
  return true; // keep the channel open for async response
});

async function handle(msg) {
  if (!msg || typeof msg.type !== "string") throw new Error("bad message");
  switch (msg.type) {
    case "getCardNames":
      return await getCardNames();
    case "getCard":
      if (!msg.name) throw new Error("missing name");
      return await getCardByName(msg.name);
    case "openViewer":
      // Same flow as the Ctrl+Shift+Space hotkey — find-or-create a viewer
      // tab. Used by the FAB panel's "Open full viewer" footer button.
      await openOrFocusViewer();
      return true;
    default:
      throw new Error(`unknown type: ${msg.type}`);
  }
}

// -----------------------------------------------------------------------
// Hotkey: Alt+Shift+Z opens (or focuses + refreshes) the clipboard viewer.
// Registered under the "open-clipboard-viewer" command name in manifest.json.
// -----------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-clipboard-viewer") return;
  try {
    await openOrFocusViewer();
  } catch (err) {
    console.warn("[CardMystic] viewer open failed", err);
  }
});

async function openOrFocusViewer() {
  const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");

  // Look for an existing viewer tab. If more than one exists (shouldn't,
  // but a user could have manually duplicated), use the first.
  const existing = await chrome.tabs.query({ url: viewerUrl });
  if (existing && existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (typeof tab.windowId === "number") {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (_) {
        // Firefox may throw if the window can't be focused; the tab switch
        // above is enough for the visibilitychange listener in viewer.js
        // to re-read the clipboard.
      }
    }
    return tab;
  }

  return await chrome.tabs.create({ url: viewerUrl });
}

// -----------------------------------------------------------------------
// Right-click menu: "Clear CardMystic clipboard"
// -----------------------------------------------------------------------
//
// Appears on every site, every link/selection/frame context, so users can
// wipe their running card list from anywhere in Chrome. Routes through
// CM.plus.clearClipboard when a content script is loaded (gets the full
// reconcile + history transition + toast); falls back to a raw
// navigator.clipboard.writeText("") on unsupported sites.

const CM_CLEAR_MENU_ID = "clear-cardmystic-clipboard";
const CM_SEND_TO_DECK_PARENT_ID = "cm-send-to-deck";

// Placeholder deck entries. Stubbed for now — clicking logs the request
// but does nothing. Replace with real deck-service lookups when the
// backend API is ready (see onClicked handler below).
const CM_PLACEHOLDER_DECKS = [
  { id: "cm-deck-placeholder-commander", title: "My Commander Deck" },
  { id: "cm-deck-placeholder-modern",    title: "Modern Brew" },
  { id: "cm-deck-placeholder-standard",  title: "Standard Testing" },
];
const CM_PLACEHOLDER_DECK_IDS = new Set(CM_PLACEHOLDER_DECKS.map((d) => d.id));

// Card-link anchors carry `href="https://cardmystic.com/card/<uuid>"` once
// the resolver lands. Targeting by URL pattern scopes the submenu to our
// own links only, on any site — so it shows on both in-page anchors and
// the FAB panel's Cards on Page hyperlinks (they share the same href).
const CM_CARD_LINK_PATTERNS = ["https://cardmystic.com/card/*"];

function registerContextMenus() {
  // removeAll guards against "Cannot create item with duplicate id" after
  // service-worker restarts on browsers that persist menu state.
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: CM_CLEAR_MENU_ID,
        title: "Clear CardMystic clipboard",
        contexts: ["page", "link", "selection", "frame", "editable"],
      });

      // "Send to Deck..." parent + placeholder children. Scoped to
      // right-clicks on resolved CardMystic card links only.
      chrome.contextMenus.create({
        id: CM_SEND_TO_DECK_PARENT_ID,
        title: "Send to Deck...",
        contexts: ["link"],
        targetUrlPatterns: CM_CARD_LINK_PATTERNS,
      });
      for (const deck of CM_PLACEHOLDER_DECKS) {
        chrome.contextMenus.create({
          id: deck.id,
          parentId: CM_SEND_TO_DECK_PARENT_ID,
          title: deck.title,
          contexts: ["link"],
          targetUrlPatterns: CM_CARD_LINK_PATTERNS,
        });
      }
    });
  } catch (err) {
    console.warn("[CardMystic] contextMenus create failed", err);
  }
}

chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

// Function injected into the active tab's content-script world. Prefers
// the extension's own helper; falls back to a raw clipboard wipe when no
// content script is present on the page.
async function clearInPage() {
  if (window.CM && window.CM.plus && window.CM.plus.clearClipboard) {
    return await window.CM.plus.clearClipboard();
  }
  try { await navigator.clipboard.writeText(""); } catch (_) {}
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // --- Clear clipboard ---
  if (info.menuItemId === CM_CLEAR_MENU_ID) {
    if (!tab || typeof tab.id !== "number") return;
    try {
      await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          frameIds: typeof info.frameId === "number" ? [info.frameId] : undefined,
        },
        // Default world is ISOLATED — same as our content scripts — so
        // window.CM (defined on the isolated-world window by plus.js) is
        // reachable here.
        func: clearInPage,
      });
    } catch (err) {
      console.warn("[CardMystic] clearClipboard via contextMenu failed", err);
    }
    return;
  }

  // --- Send to Deck... placeholder ---
  // Intentionally a stub today. info.linkUrl carries the CardMystic card
  // URL the user right-clicked; we'll extract the UUID and POST to the
  // real deck service once it exists.
  if (CM_PLACEHOLDER_DECK_IDS.has(info.menuItemId)) {
    const deck = CM_PLACEHOLDER_DECKS.find((d) => d.id === info.menuItemId);
    console.log("[CardMystic] send-to-deck (stub)", {
      deck: deck && deck.title,
      cardUrl: info.linkUrl,
    });
    return;
  }
});
