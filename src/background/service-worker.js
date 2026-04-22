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
