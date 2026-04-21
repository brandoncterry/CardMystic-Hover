// Simple TTL cache backed by chrome.storage.local.
// Stored value shape: { v: <value>, exp: <epoch ms> }  (exp = 0 means no expiry)

export async function getCached(key) {
  const out = await chrome.storage.local.get(key);
  const entry = out[key];
  if (!entry) return null;
  if (entry.exp && Date.now() > entry.exp) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry.v;
}

export async function setCached(key, value, ttlMs) {
  const exp = ttlMs ? Date.now() + ttlMs : 0;
  await chrome.storage.local.set({ [key]: { v: value, exp } });
}
