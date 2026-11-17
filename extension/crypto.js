/* PromptVeil crypto helpers (WebCrypto only, no Chrome APIs, so Node can test them too).
 *
 * The word lists are stored as one AES-256-GCM blob:
 *   { v: 1, mode: "device" | "password", iv, ct, kdf? }
 * with a fresh random 12-byte IV on every save. The additional authenticated data binds the
 * format and mode, so a blob can't be relabelled from one mode to the other.
 *   - device mode: a random key generated once, non-extractable, kept in IndexedDB.
 *   - password mode: PBKDF2-SHA256 with 600,000 iterations and a random 16-byte salt.
 * Backups use the same password scheme with their own salt.
 */
(function (root) {
  "use strict";
  const subtle = root.crypto.subtle;
  const ITERATIONS = 600000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64(bytes) {
    let s = "";
    const u = new Uint8Array(bytes);
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(String(str));
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  const random = n => root.crypto.getRandomValues(new Uint8Array(n));

  // A fresh device key: AES-256-GCM, non-extractable (scripts can use it, not read its bytes).
  function newDeviceKey() {
    return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // PBKDF2-SHA256 -> 32 raw key bytes. The raw bytes are what the service worker keeps in
  // chrome.storage.session (memory only) while unlocked; they are never written to disk.
  async function deriveKeyBytes(password, salt, iterations = ITERATIONS) {
    if (typeof password !== "string" || !password) throw new Error("empty password");
    const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
    return new Uint8Array(bits);
  }
  function keyFromBytes(bytes) {
    return subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function encryptJSON(key, value, aad) {
    const iv = random(12);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  // Throws "wrong key" for a wrong password/key or a tampered blob (GCM authentication fails).
  async function decryptJSON(key, box, aad) {
    let pt;
    try {
      pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: enc.encode(aad) }, key, unb64(box.ct));
    } catch (_) {
      throw new Error("wrong key");
    }
    return JSON.parse(dec.decode(pt));
  }

  const listsAad = mode => `promptveil-lists-v1:${mode}`;

  function cleanLists(lists) {
    const clean = a => (Array.isArray(a) ? a : []).filter(x => typeof x === "string").map(x => x.trim()).filter(Boolean).slice(0, 5000);
    return { terms: clean(lists && lists.terms), allow: clean(lists && lists.allow) };
  }

  // Seal the lists. `kdf` ({ salt, iterations }) is recorded for password mode so the key can be
  // derived again at unlock.
  async function sealLists(key, mode, lists, kdf) {
    const box = await encryptJSON(key, cleanLists(lists), listsAad(mode));
    const out = { v: 1, mode, iv: box.iv, ct: box.ct };
    if (mode === "password") out.kdf = { name: "PBKDF2-SHA256", iterations: kdf.iterations, salt: b64(kdf.salt) };
    return out;
  }
  async function openLists(key, sealed) {
    return cleanLists(await decryptJSON(key, sealed, listsAad(sealed.mode)));
  }

  // Password-protected backup file, independent of how the lists are stored.
  async function exportBackup(lists, password) {
    const salt = random(16);
    const key = await keyFromBytes(await deriveKeyBytes(password, salt));
    const box = await encryptJSON(key, cleanLists(lists), "promptveil-backup-v1");
    return JSON.stringify({
      format: "promptveil-lists-backup", v: 1, cipher: "AES-256-GCM",
      kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt) }, iv: box.iv, ct: box.ct,
    }, null, 2);
  }
  async function importBackup(text, password) {
    let f;
    try { f = JSON.parse(text); } catch (_) { throw new Error("not a PromptVeil backup"); }
    if (!f || f.format !== "promptveil-lists-backup" || f.v !== 1 || !f.kdf || typeof f.iv !== "string" || typeof f.ct !== "string") {
      throw new Error("not a PromptVeil backup");
    }
    const iterations = Number(f.kdf.iterations);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 10000000) throw new Error("not a PromptVeil backup");
    const key = await keyFromBytes(await deriveKeyBytes(password, unb64(f.kdf.salt), iterations));
    return cleanLists(await decryptJSON(key, f, "promptveil-backup-v1"));
  }

  async function sha256(text) {
    return b64(await subtle.digest("SHA-256", enc.encode(text)));
  }

  root.PromptVeilCrypto = {
    ITERATIONS, b64, unb64, random, newDeviceKey, deriveKeyBytes, keyFromBytes,
    sealLists, openLists, cleanLists, exportBackup, importBackup, sha256,
  };
})(typeof self !== "undefined" ? self : globalThis);
