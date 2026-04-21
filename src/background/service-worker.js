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
