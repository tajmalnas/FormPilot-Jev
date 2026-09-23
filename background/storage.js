// The service worker is the only component that ever touches the API key.
// Default mode: chrome.storage.session (memory only, wiped when Chrome closes).
// "Remember" mode: chrome.storage.local, AES-GCM encrypted with a passphrase
// (WebCrypto PBKDF2); the decrypted key is cached in session storage after
// unlock so the user doesn't re-enter the passphrase every fill.

const SESSION_KEY = "fp_api_key";
const LOCAL_ENC_KEY = "fp_api_key_encrypted";
const PROFILE_KEY = "profile";
const LAST_RUN_KEY = "fp_last_run";
const SETTINGS_KEY = "fp_settings";

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

async function deriveKey(passphrase, saltBuf) {
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations: 150000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function saveApiKey({ key, remember, passphrase }) {
  if (remember) {
    if (!passphrase) throw new Error("A passphrase is required to remember the key.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await deriveKey(passphrase, salt);
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, enc.encode(key));
    await chrome.storage.local.set({
      [LOCAL_ENC_KEY]: { cipher: toB64(cipher), iv: toB64(iv), salt: toB64(salt) }
    });
  } else {
    await chrome.storage.local.remove(LOCAL_ENC_KEY);
  }
  // Always cache plaintext for this browser session so fills work immediately.
  await chrome.storage.session.set({ [SESSION_KEY]: key });
}

export async function unlockRememberedKey(passphrase) {
  const store = await chrome.storage.local.get(LOCAL_ENC_KEY);
  const blob = store[LOCAL_ENC_KEY];
  if (!blob) return { ok: false, error: "No remembered key is stored." };
  try {
    const cryptoKey = await deriveKey(passphrase, fromB64(blob.salt));
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(blob.iv) }, cryptoKey, fromB64(blob.cipher));
    const key = dec.decode(plainBuf);
    await chrome.storage.session.set({ [SESSION_KEY]: key });
    return { ok: true };
  } catch {
    return { ok: false, error: "Wrong passphrase." };
  }
}

// Returns one of: { state: "ready", key } | { state: "locked" } | { state: "missing" }
export async function getApiKeyState() {
  const session = await chrome.storage.session.get(SESSION_KEY);
  if (session[SESSION_KEY]) return { state: "ready", key: session[SESSION_KEY] };
  const local = await chrome.storage.local.get(LOCAL_ENC_KEY);
  if (local[LOCAL_ENC_KEY]) return { state: "locked" };
  return { state: "missing" };
}

export async function clearApiKey() {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.storage.local.remove(LOCAL_ENC_KEY);
}

export async function getProfile() {
  const store = await chrome.storage.local.get(PROFILE_KEY);
  return store[PROFILE_KEY] || null;
}

export async function saveLastRun(summary) {
  await chrome.storage.session.set({ [LAST_RUN_KEY]: summary });
}

export async function getLastRun() {
  const store = await chrome.storage.session.get(LAST_RUN_KEY);
  return store[LAST_RUN_KEY] || null;
}

export async function getSettings() {
  const store = await chrome.storage.local.get(SETTINGS_KEY);
  return store[SETTINGS_KEY] || { model: "jev-1.13.0" };
}

export async function deleteEverything() {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
}
