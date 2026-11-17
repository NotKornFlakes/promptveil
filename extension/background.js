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

// --- "Restore with PromptVeil" right-click menu ---------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "pv-restore",
    title: "Restore real values with PromptVeil",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "pv-restore") return;
  let text = info.selectionText || "";
  try {
    // selectionText collapses line breaks; read the selection directly to keep formatting.
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId || 0] },
      func: () => String(getSelection()),
    });
    if (res && res.result) text = res.result;
  } catch (_) { /* page not scriptable: fall back to selectionText */ }
  await chrome.storage.session.set({ pendingRestore: text });
  chrome.windows.create({ url: "popup.html?view=restore&window=1", type: "popup", width: 440, height: 640 });
});
