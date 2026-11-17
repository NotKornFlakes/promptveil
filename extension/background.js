/* PromptVeil service worker.
 * Owns the vault (placeholder -> real value). The vault lives in chrome.storage.session:
 * memory only, never written to disk, wiped when the browser closes.
 * Owns the word lists ("Always hide" / "Never hide"), stored encrypted in chrome.storage.local
 * (see crypto.js). In password mode the derived key is kept only in chrome.storage.session while
 * unlocked; while locked, scrubbing still works with the built-in detectors.
 * Content scripts may ask for scrubbing, a yes/no "does this text contain known placeholders?",
 * a count-only scan of typed text, and "restore this and put it on the clipboard" (they get back
 * a count, never the text). Restored text only ever exists in extension contexts: this worker,
 * the offscreen clipboard document and PromptVeil's own pages. It is never put back into an AI
 * site's page.
 */
importScripts("engine.js", "crypto.js");
const { Veil, LABELS } = self.PromptVeil;
const C = self.PromptVeilCrypto;

const DEFAULTS = { disabledSites: [], guardTyped: false };
const MAX_TEXT = 1_000_000; // characters; bigger requests are refused
const MIN_PASSWORD = 8;
const AI_SITES = chrome.runtime.getManifest().content_scripts[0].matches;

// --- startup ----------------------------------------------------------------------------
// Session storage must be closed to content scripts before any key is written to it. It is by
// default, but we set it explicitly and refuse to store a key until this has succeeded.
let sessionRestricted = false;
const ready = (async () => {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  sessionRestricted = true;
  await migrateLists().catch(() => {}); // retried on the next start or unlock
})();

// --- device key (IndexedDB) ---------------------------------------------------------------
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("promptveil", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("keys", mode);
      const req = fn(tx.objectStore("keys"));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
let deviceKeyPromise = null;
function deviceKey() {
  if (!deviceKeyPromise) {
    deviceKeyPromise = (async () => {
      let key = await idb("readonly", st => st.get("device"));
      if (!key) {
        key = await C.newDeviceKey(); // non-extractable
        await idb("readwrite", st => st.put(key, "device"));
      }
      return key;
    })();
    deviceKeyPromise.catch(() => { deviceKeyPromise = null; });
  }
  return deviceKeyPromise;
}

// --- password key (chrome.storage.session, memory only) -----------------------------------
async function sessionKey() {
  const { listKey } = await chrome.storage.session.get("listKey");
  return listKey ? C.keyFromBytes(C.unb64(listKey)) : null;
}
async function putSessionKey(bytes) {
  if (!sessionRestricted) throw new Error("session storage is not restricted yet");
  await chrome.storage.session.set({ listKey: C.b64(bytes) });
}
async function lock() {
  await chrome.storage.session.remove("listKey");
  listsCache = null;
}

// --- word lists ---------------------------------------------------------------------------
let listsCache = null; // decrypted { terms, allow, ct } in this worker's memory only
const sealedLists = async () => (await chrome.storage.local.get("lists")).lists || null;

// { mode, locked, broken, lists }. lists is null when locked or undecryptable.
async function listState() {
  const sealed = await sealedLists();
  if (!sealed) return { mode: "device", locked: false, broken: false, lists: { terms: [], allow: [] } };
  if (listsCache && listsCache.ct === sealed.ct) return { mode: sealed.mode, locked: false, broken: false, lists: listsCache };
  const key = sealed.mode === "password" ? await sessionKey() : await deviceKey();
  if (!key) return { mode: sealed.mode, locked: true, broken: false, lists: null };
  try {
    listsCache = { ...(await C.openLists(key, sealed)), ct: sealed.ct };
  } catch (_) {
    // Device key gone (profile data cleared) or a stale session key: can't decrypt.
    return { mode: sealed.mode, locked: sealed.mode === "password", broken: sealed.mode === "device", lists: null };
  }
  return { mode: sealed.mode, locked: false, broken: false, lists: listsCache };
}

async function saveLists(lists) {
  const sealed = await sealedLists();
  const mode = sealed ? sealed.mode : "device";
  let key, kdf;
  if (mode === "password") {
    key = await sessionKey();
    if (!key) throw new Error("locked");
    kdf = { salt: C.unb64(sealed.kdf.salt), iterations: sealed.kdf.iterations };
  } else {
    key = await deviceKey();
  }
  const out = await C.sealLists(key, mode, lists, kdf); // fresh IV every save
  await chrome.storage.local.set({ lists: out });
  listsCache = { ...C.cleanLists(lists), ct: out.ct };
}

// Lists from older versions were plain text in chrome.storage.local ("terms" / "allow"). Encrypt
// them and delete the plain copy. In password mode while locked this waits for the next unlock.
async function migrateLists() {
  const old = await chrome.storage.local.get(["terms", "allow"]);
  if (old.terms === undefined && old.allow === undefined) return;
  const st = await listState();
  if (!st.lists) return;
  const plain = C.cleanLists(old);
  const union = (a, b) => [...new Set([...a, ...b])];
  await saveLists({ terms: union(st.lists.terms, plain.terms), allow: union(st.lists.allow, plain.allow) });
  await chrome.storage.local.remove(["terms", "allow"]);
}

async function setPassword(password) {
  checkPassword(password);
  const st = await listState();
  if (!st.lists) throw new Error("locked");
  const salt = C.random(16);
  const bytes = await C.deriveKeyBytes(password, salt);
  const out = await C.sealLists(await C.keyFromBytes(bytes), "password", st.lists, { salt, iterations: C.ITERATIONS });
  await putSessionKey(bytes);
  await chrome.storage.local.set({ lists: out });
  listsCache = { ...st.lists, ct: out.ct };
}

async function removePassword() {
  const st = await listState();
  if (st.mode !== "password") return;
  if (!st.lists) throw new Error("locked");
  const out = await C.sealLists(await deviceKey(), "device", st.lists);
  await chrome.storage.local.set({ lists: out });
  await chrome.storage.session.remove("listKey");
  listsCache = { ...st.lists, ct: out.ct };
}

async function unlock(password) {
  const sealed = await sealedLists();
  if (!sealed || sealed.mode !== "password") return;
  if (typeof password !== "string" || !password || password.length > 1024) throw new Error("wrong password");
  const bytes = await C.deriveKeyBytes(password, C.unb64(sealed.kdf.salt), sealed.kdf.iterations);
  let lists;
  try {
    lists = await C.openLists(await C.keyFromBytes(bytes), sealed);
  } catch (_) {
    throw new Error("wrong password");
  }
  await putSessionKey(bytes);
  listsCache = { ...lists, ct: sealed.ct };
  await migrateLists().catch(() => {});
}

function checkPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  if (password.length > 1024) throw new Error("password too long");
}

// Scrubbing settings. While locked (or undecryptable) the custom lists are left out, so the
// built-in detectors still run. The allow list is left out too, so more is hidden, never less.
async function settings() {
  const plain = await chrome.storage.local.get(DEFAULTS);
  const st = await listState();
  return { ...plain, terms: st.lists ? st.lists.terms : [], allow: st.lists ? st.lists.allow : [], locked: !st.lists };
}
async function getMapping() {
  return (await chrome.storage.session.get({ mapping: {} })).mapping;
}

// Serialize vault writes so two quick pastes can't clobber each other's placeholders.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function summarize(findings) {
  const counts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ kind: k, label: LABELS[k] || k, n }));
}

function textOf(msg) {
  const text = msg.text;
  if (typeof text !== "string") throw new Error("text must be a string");
  if (text.length > MAX_TEXT) throw new Error("text too large");
  return text;
}
const stringList = v => (Array.isArray(v) && v.length <= 5000 && v.every(x => typeof x === "string" && x.length <= 1000) ? v : null);

// True only for PromptVeil's own pages (popup, restore window). Content scripts report the
// AI site's URL here, so they can never pull real values out of the vault.
const fromExtensionPage = sender =>
  sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));

// Tell the AI-site tabs the vault changed so their "Copy with real values" buttons are re-checked.
async function vaultChanged() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: AI_SITES }); } catch (_) { return; }
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "vault-changed" }).catch(() => {});
}

// --- clipboard, through the offscreen document ------------------------------------------
const OFFSCREEN = "offscreen.html";
let clip = Promise.resolve();

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN);
  if (chrome.runtime.getContexts) {
    const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (open.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ["CLIPBOARD"],
      justification: "Copy text with restored values to the clipboard",
    });
  } catch (e) {
    if (!/single offscreen/i.test(String(e && e.message))) throw e; // already open: fine
  }
}

// One clipboard write at a time; the document is closed again after each write.
function writeClipboard(text) {
  const run = clip.then(async () => {
    await ensureOffscreen();
    try {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "clipboard-write", text });
      if (!r || r.ok !== true) throw new Error("clipboard write failed");
    } finally {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  });
  clip = run.catch(() => {});
  return run;
}

// Restore `text` and copy it. Returns only a count (plus why nothing happened), never the text.
async function restoreToClipboard(text) {
  const mapping = await getMapping();
  if (!Object.keys(mapping).length) return { count: 0, reason: "empty" };
  const r = new Veil({ mapping }).restore(text);
  if (!r.count) return { count: 0, reason: "none" };
  await writeClipboard(r.text);
  return { count: r.count };
}

async function handle(msg, sender) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") throw new Error("bad message");
  if (sender.id !== chrome.runtime.id) throw new Error("not allowed");
  await ready;
  switch (msg.type) {
    case "scrub": {
      const text = textOf(msg);
      const r = await serial(async () => {
        const s = await settings();
        const before = await getMapping();
        const v = new Veil({ mapping: before, terms: s.terms, allow: s.allow });
        const out = v.scrub(text);
        await chrome.storage.session.set({ mapping: v.mapping });
        return { out, locked: s.locked, grew: Object.keys(v.mapping).length > Object.keys(before).length };
      });
      if (r.grew) vaultChanged();
      return { text: r.out.text, total: r.out.findings.length, counts: summarize(r.out.findings), locked: r.locked };
    }

    case "scan": {
      // Optional "check typed text before sending". Counts only, nothing is added to the vault.
      const text = textOf(msg);
      const s = await settings();
      if (!s.guardTyped) throw new Error("typed-text check is off");
      const findings = new Veil({ terms: s.terms, allow: s.allow }).find(text);
      return { total: findings.length, counts: summarize(findings) };
    }

    case "has": {
      // Yes/no only. The answer reveals whether a placeholder name exists, never its value.
      const text = textOf(msg);
      return { found: new Veil({ mapping: await getMapping() }).restore(text).count > 0 };
    }

    case "copyRestored":
      // The content script sends this only after a trusted click on its own button.
      return restoreToClipboard(textOf(msg));
  }

  // Everything below is for PromptVeil's own pages only.
  if (!fromExtensionPage(sender)) throw new Error("not allowed");
  switch (msg.type) {
    case "restore":
      return new Veil({ mapping: await getMapping() }).restore(textOf(msg));

    case "vault":
      return { mapping: await getMapping() };

    case "reset":
      await chrome.storage.session.set({ mapping: {} });
      vaultChanged();
      return { ok: true };

    case "lists.get": {
      const st = await listState();
      return { mode: st.mode, locked: st.locked, broken: st.broken, terms: st.lists ? st.lists.terms : null, allow: st.lists ? st.lists.allow : null };
    }
    case "lists.set": {
      const terms = stringList(msg.terms), allow = stringList(msg.allow);
      if (!terms || !allow) throw new Error("bad lists");
      await serial(() => saveLists({ terms, allow }));
      return { ok: true };
    }
    case "lists.reset": // "Forgot password": delete the lists and start over without a password
      await serial(async () => { await chrome.storage.local.remove(["lists", "terms", "allow"]); await lock(); });
      return { ok: true };
    case "lists.export": {
      const st = await listState();
      if (!st.lists) throw new Error("locked");
      checkPassword(msg.password);
      return { data: await C.exportBackup(st.lists, msg.password) };
    }
    case "lists.import": {
      if (typeof msg.data !== "string" || msg.data.length > MAX_TEXT) throw new Error("not a PromptVeil backup");
      if (typeof msg.password !== "string" || !msg.password) throw new Error("wrong password");
      let lists;
      try {
        lists = await C.importBackup(msg.data, msg.password);
      } catch (e) {
        throw new Error(e.message === "wrong key" ? "wrong password" : "not a PromptVeil backup");
      }
      await serial(() => saveLists(lists));
      return { terms: lists.terms.length, allow: lists.allow.length };
    }

    case "lock.unlock":
      await serial(() => unlock(msg.password));
      return { ok: true };
    case "lock.lock":
      await serial(lock);
      return { ok: true };
    case "lock.set": // turn the password on, or change it (needs the lists unlocked)
      await serial(() => setPassword(msg.password));
      return { ok: true };
    case "lock.remove":
      await serial(removePassword);
      return { ok: true };

    default:
      throw new Error("unknown message");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === "offscreen") return false; // for the offscreen document, not us
  handle(msg, sender).then(sendResponse, e => sendResponse({ error: String((e && e.message) || "failed") }));
  return true;
});

// --- restore the selection: right-click menu (and keyboard shortcut) ---------------------
const MENU_COPY = "pv-restore";
const MENU_VIEW = "pv-restore-view";

chrome.runtime.onInstalled.addListener(async details => {
  // First install only (not updates): show how it works, with a demo box.
  if (details.reason === "install") chrome.tabs.create({ url: "welcome.html" }).catch(() => {});
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_COPY, title: "Restore real values with PromptVeil", contexts: ["selection"] });
  chrome.contextMenus.create({ id: MENU_VIEW, title: "Restore and view…", contexts: ["selection"] });
});

// Read the selection with line breaks (selectionText collapses them). Only works on the AI
// sites (our host permissions). Returns null when the page can't be read.
async function readSelection(tab, frameIds) {
  if (!tab || tab.id < 0) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: frameIds ? { tabId: tab.id, frameIds } : { tabId: tab.id, allFrames: true },
      func: () => ({ text: String(getSelection()), focused: document.hasFocus() }),
    });
    const found = results.map(r => r && r.result).filter(r => r && r.text);
    const pick = found.find(r => r.focused) || found[0];
    return pick ? pick.text : "";
  } catch (_) {
    return null; // not an AI site, or a page Chrome doesn't let extensions script
  }
}

// What to tell the user. Never includes the text itself.
function feedback(r) {
  const s = n => (n === 1 ? "" : "s");
  switch (r.reason) {
    case undefined: return { title: `Copied with ${r.count} real value${s(r.count)} restored`, detail: "Paste it wherever you need it. The page never saw them." };
    case "noselection": return { title: "Nothing selected", detail: "Select the AI's answer first.", bad: true };
    case "noaccess": return { title: "Can't read the selection here", detail: "The shortcut works on the AI chat sites. Elsewhere, right-click → Restore real values.", bad: true };
    case "toolong": return { title: "Selection too long", detail: "Select a shorter part of the answer.", bad: true };
    case "empty": return { title: "Nothing to restore", detail: "The vault is empty. It's cleared when the browser closes or you start a new session.", bad: true };
    case "none": return { title: "Nothing to restore", detail: "The selection has no placeholders PromptVeil knows.", bad: true };
    default: return { title: "Couldn't copy", detail: "Select the text, right-click → Restore and view…", bad: true };
  }
}

const badgeTimers = new Map();
async function notify(tab, r) {
  const f = feedback(r);
  const tabId = tab && tab.id >= 0 ? tab.id : undefined;
  if (tabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "toast", title: f.title, detail: f.detail, bad: !!f.bad }, { frameId: 0 });
      return;
    } catch (_) { /* no PromptVeil content script here (not an AI site): use the badge */ }
  }
  const text = f.bad ? "!" : r.count > 99 ? "99+" : String(r.count);
  await chrome.action.setBadgeBackgroundColor({ color: f.bad ? "#d1242f" : "#0f9d74", tabId });
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setTitle({ title: `PromptVeil: ${f.title}`, tabId });
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
    chrome.action.setTitle({ title: "PromptVeil", tabId }).catch(() => {});
  }, 4000));
}

async function copySelection(tab, text) {
  let r;
  if (text === null) r = { count: 0, reason: "noaccess" };
  else if (!text) r = { count: 0, reason: "noselection" };
  else if (text.length > MAX_TEXT) r = { count: 0, reason: "toolong" };
  else {
    try { r = await restoreToClipboard(text); } catch (_) { r = { count: 0, reason: "error" }; }
  }
  await notify(tab, r);
  return r;
}

async function onMenuClick(info, tab) {
  if (info.menuItemId !== MENU_COPY && info.menuItemId !== MENU_VIEW) return;
  // Outside the AI sites, fall back to Chrome's selectionText (line breaks collapsed).
  let text = await readSelection(tab, [info.frameId || 0]);
  if (!text) text = info.selectionText || "";
  if (info.menuItemId === MENU_COPY) return copySelection(tab, text);
  // "Restore and view…": the restore window shows the result before you copy it.
  await chrome.storage.session.set({ pendingRestore: text });
  await chrome.windows.create({ url: "popup.html?view=restore&window=1", type: "popup", width: 440, height: 640 });
}
chrome.contextMenus.onClicked.addListener(onMenuClick);

// Keyboard shortcut (Ctrl+Shift+Y / Cmd+Shift+Y by default): same as the right-click item.
async function onCommand(command, tab) {
  if (command !== "restore-selection") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return copySelection(tab, await readSelection(tab, null));
}
chrome.commands.onCommand.addListener(onCommand);
