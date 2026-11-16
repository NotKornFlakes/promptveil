/* PromptVeil service worker.
 * Owns the vault (placeholder -> real value). The vault lives in chrome.storage.session:
 * memory only, never written to disk, wiped when the browser closes.
 * Content scripts may only ask for *scrubbing*. Restoring real values is only allowed from
 * extension pages (popup / restore window), so real data is never put back into an AI site's page.
 */
importScripts("engine.js");
const { Veil, LABELS } = self.PromptVeil;

const DEFAULTS = { terms: [], allow: [], disabledSites: [] };

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

// True only for PromptVeil's own pages (popup, restore window). Content scripts report the
// AI site's URL here, so they can never pull real values out of the vault.
const fromExtensionPage = sender =>
  sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));

async function handle(msg, sender) {
  switch (msg.type) {
    case "scrub":
      return locked(async () => {
        const s = await settings();
        const v = new Veil({ mapping: await getMapping(), terms: s.terms, allow: s.allow });
        const r = v.scrub(String(msg.text || ""));
        await chrome.storage.session.set({ mapping: v.mapping });
        return { text: r.text, total: r.findings.length, counts: summarize(r.findings) };
      });

    case "restore":
      if (!fromExtensionPage(sender)) throw new Error("restore is only allowed from the PromptVeil popup");
      return new Veil({ mapping: await getMapping() }).restore(String(msg.text || ""));

    case "vault":
      if (!fromExtensionPage(sender)) throw new Error("not allowed");
      return { mapping: await getMapping() };

    case "reset":
      if (!fromExtensionPage(sender)) throw new Error("not allowed");
      await chrome.storage.session.set({ mapping: {} });
      return { ok: true };

    default:
      throw new Error("unknown message");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
