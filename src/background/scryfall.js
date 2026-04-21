// Scryfall API client with caching, in-flight dedupe, and a simple rate limit.
//
// Scryfall asks clients to stay under ~10 req/s and to identify themselves.
// We cache aggressively so steady-state traffic is dominated by first-time
// lookups.
//
// The big scaling win for pages like Moxfield decklists (hundreds of cards)
// is the **batched collection endpoint**:
//
//   POST https://api.scryfall.com/cards/collection
//   body: { "identifiers": [{"name": "Lightning Bolt"}, ...]  }  // up to 75
//
// `getCardByName` no longer fires one HTTP request per card — it pushes the
// lookup onto a short-lived queue that is flushed after a 30 ms debounce or
// when it reaches 75 entries. A 200-card deck page now needs ~3 HTTP calls
// instead of ~200 (and they happen in parallel with the first paint of the
// page, not serialized across 22 seconds of throttling).

import { getCached, setCached } from "./cache.js";

const API = "https://api.scryfall.com";
const HEADERS = { Accept: "application/json" };

const CATALOG_KEY = "scryfall:card-names";
const CATALOG_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CARD_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;    // 1 day for "not found"

const BATCH_WINDOW_MS = 30;  // coalesce lookups arriving within this window
const BATCH_MAX = 75;        // scryfall's limit for /cards/collection

// --- Rate limiting: at most one request every ~110ms (≈9/s) ---
let nextSlot = 0;
function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 110;
  return wait ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

// --- In-flight dedupe so N hovers for the same card share one lookup ---
const inflightCard = new Map(); // key: lowercased name -> Promise

// --- Pending batch for the collection endpoint ---
let pendingBatch = []; // Array<{name, key, resolve, reject}>
let batchTimer = null;

function cardKey(name) {
  return `scryfall:card:${name.toLowerCase()}`;
}

function scheduleFlush() {
  if (pendingBatch.length >= BATCH_MAX) {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    flushBatch();
    return;
  }
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushBatch();
    }, BATCH_WINDOW_MS);
  }
}

async function flushBatch() {
  const batch = pendingBatch;
  pendingBatch = [];
  if (!batch.length) return;

  // Walk in chunks of BATCH_MAX. We may have reached the limit mid-window,
  // which already triggered a flush; this loop is just defensive.
  for (let i = 0; i < batch.length; i += BATCH_MAX) {
    const slice = batch.slice(i, i + BATCH_MAX);
    try {
      await runCollection(slice);
    } catch (err) {
      for (const item of slice) item.reject(err);
    }
  }
}

async function runCollection(items) {
  // Dedupe by key. Multiple callers asking for the same card share a result.
  const byKey = new Map();
  for (const item of items) {
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key).push(item);
  }

  const identifiers = Array.from(byKey.values()).map((group) => ({
    name: group[0].name,
  }));

  await throttle();
  const res = await fetch(`${API}/cards/collection`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error(`Scryfall collection ${res.status}`);
  const json = await res.json();

  // Index returned cards by lowercased name (the canonical Scryfall name).
  const foundByName = new Map();
  if (Array.isArray(json.data)) {
    for (const card of json.data) {
      const slim = slimCard(card);
      foundByName.set(card.name.toLowerCase(), slim);
      // Also cache under the canonical key.
      setCached(`scryfall:card:${card.name.toLowerCase()}`, slim, CARD_TTL);
    }
  }

  // Resolve each pending item. We prefer an exact match on the requested name
  // (lowercased); if nothing matches, treat as not_found and negative-cache.
  for (const [key, group] of byKey) {
    const requested = group[0].name.toLowerCase();
    let result = foundByName.get(requested);
    if (!result) {
      // Scryfall might have returned the card under its canonical name if
      // we requested a card face or an alias. As a fallback, if the whole
      // response has exactly one card, use it.
      if (foundByName.size === 1 && items.length === 1) {
        result = foundByName.values().next().value;
      }
    }
    if (!result) {
      result = { notFound: true };
      setCached(key, result, NEGATIVE_TTL);
    } else {
      // Make sure the requested key is cached too (in case canonical name
      // differs from the one the content script asked for).
      setCached(key, result, CARD_TTL);
    }
    for (const item of group) item.resolve(result);
  }
}

export async function getCardNames() {
  const cached = await getCached(CATALOG_KEY);
  if (cached) return cached;

  await throttle();
  const res = await fetch(`${API}/catalog/card-names`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Scryfall catalog ${res.status}`);
  const json = await res.json();
  const names = Array.isArray(json.data) ? json.data : [];
  await setCached(CATALOG_KEY, names, CATALOG_TTL);
  return names;
}

export async function getCardByName(name) {
  const key = cardKey(name);
  const cached = await getCached(key);
  if (cached) return cached;

  if (inflightCard.has(key)) return inflightCard.get(key);

  const p = new Promise((resolve, reject) => {
    pendingBatch.push({ name, key, resolve, reject });
    scheduleFlush();
  }).finally(() => {
    inflightCard.delete(key);
  });
  inflightCard.set(key, p);
  return p;
}

// Keep only the fields the extension needs so cache stays small.
function slimCard(card) {
  const pickImg = (src) => src && (src.normal || src.large || src.small || null);
  const out = {
    id: card.id,
    name: card.name,
    image: pickImg(card.image_uris),
    faces: null,
  };
  if (Array.isArray(card.card_faces) && card.card_faces.length) {
    out.faces = card.card_faces.map((f) => ({
      name: f.name,
      image: pickImg(f.image_uris),
    }));
    if (!out.image && out.faces[0]) out.image = out.faces[0].image;
  }
  return out;
}
