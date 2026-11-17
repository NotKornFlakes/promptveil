/* PromptVeil service worker.
 * Owns the vault (placeholder -> real value). The vault lives in chrome.storage.session:
 * memory only, never written to disk, wiped when the browser closes.
 * Content scripts may ask for scrubbing, a yes/no "does this text contain known placeholders?",
 * and "restore this and put it on the clipboard" (they get back a count, never the text).
 * Restored text only ever exists in extension contexts: this worker, the offscreen clipboard
 * document and PromptVeil's own pages. It is never put back into an AI site's page.
 */
importScripts("engine.js");
const { Veil, LABELS } = self.PromptVeil;

const DEFAULTS = { terms: [], allow: [], disabledSites: [] };
const MAX_TEXT = 1_000_000; // characters; bigger requests are refused
const AI_SITES = chrome.runtime.getManifest().content_scripts[0].matches;

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}
async function getMapping() {
  return (await chrome.storage.session.get({ mapping: {} })).mapping;
}

// Serialize vault writes so two quick pastes can't clobber each other's placeholders.
let queue = Promise.resolve();
function locked(fn) {
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
  switch (msg.type) {
    case "scrub": {
      const text = textOf(msg);
      const r = await locked(async () => {
        const s = await settings();
        const before = await getMapping();
        const v = new Veil({ mapping: before, terms: s.terms, allow: s.allow });
        const out = v.scrub(text);
        await chrome.storage.session.set({ mapping: v.mapping });
        return { out, grew: Object.keys(v.mapping).length > Object.keys(before).length };
      });
      if (r.grew) vaultChanged();
      return { text: r.out.text, total: r.out.findings.length, counts: summarize(r.out.findings) };
    }

    case "has": {
      // Yes/no only. The answer reveals whether a placeholder name exists, never its value.
      const text = textOf(msg);
      return { found: new Veil({ mapping: await getMapping() }).restore(text).count > 0 };
    }

    case "copyRestored":
      // The content script sends this only after a trusted click on its own button.
      return restoreToClipboard(textOf(msg));

    case "restore":
      if (!fromExtensionPage(sender)) throw new Error("restore is only allowed from the PromptVeil popup");
      return new Veil({ mapping: await getMapping() }).restore(textOf(msg));

    case "vault":
      if (!fromExtensionPage(sender)) throw new Error("not allowed");
      return { mapping: await getMapping() };

    case "reset":
      if (!fromExtensionPage(sender)) throw new Error("not allowed");
      await chrome.storage.session.set({ mapping: {} });
      vaultChanged();
      return { ok: true };

    default:
      throw new Error("unknown message");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === "offscreen") return false; // for the offscreen document, not us
  handle(msg, sender).then(sendResponse, e => sendResponse({ error: String(e.message || e) }));
  return true;
});

// --- restore the selection: right-click menu (and keyboard shortcut) ---------------------
const MENU_COPY = "pv-restore";
const MENU_VIEW = "pv-restore-view";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_COPY, title: "Restore real values with PromptVeil", contexts: ["selection"] });
  chrome.contextMenus.create({ id: MENU_VIEW, title: "Restore and view…", contexts: ["selection"] });
});

// Read the selection with line breaks (selectionText collapses them). Only works on the AI
// sites (our host permissions); anywhere else we fall back to what Chrome gave us.
async function readSelection(tab, frameIds, fallback) {
  if (tab && tab.id >= 0) {
    try {
      const results = await chrome.scripting.executeScript({
        target: frameIds ? { tabId: tab.id, frameIds } : { tabId: tab.id, allFrames: true },
        func: () => ({ text: String(getSelection()), focused: document.hasFocus() }),
      });
      const found = results.map(r => r && r.result).filter(r => r && r.text);
      const pick = found.find(r => r.focused) || found[0];
      if (pick) return pick.text;
    } catch (_) { /* page not scriptable */ }
  }
  return fallback || "";
}

// What to tell the user. Never includes the text itself.
function feedback(r) {
  const s = n => (n === 1 ? "" : "s");
  switch (r.reason) {
    case undefined: return { title: `Copied with ${r.count} real value${s(r.count)} restored`, detail: "Paste it wherever you need it. The page never saw them." };
    case "noselection": return { title: "Nothing selected", detail: "Select the AI's answer first.", bad: true };
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
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}), 4000));
}

async function copySelection(tab, text) {
  let r;
  if (!text) r = { count: 0, reason: "noselection" };
  else if (text.length > MAX_TEXT) r = { count: 0, reason: "toolong" };
  else {
    try { r = await restoreToClipboard(text); } catch (_) { r = { count: 0, reason: "error" }; }
  }
  await notify(tab, r);
  return r;
}

async function onMenuClick(info, tab) {
  if (info.menuItemId !== MENU_COPY && info.menuItemId !== MENU_VIEW) return;
  const text = await readSelection(tab, [info.frameId || 0], info.selectionText);
  if (info.menuItemId === MENU_COPY) return copySelection(tab, text);
  // "Restore and view…": the restore window shows the result before you copy it.
  await chrome.storage.session.set({ pendingRestore: text });
  await chrome.windows.create({ url: "popup.html?view=restore&window=1", type: "popup", width: 440, height: 640 });
}
chrome.contextMenus.onClicked.addListener(onMenuClick);
