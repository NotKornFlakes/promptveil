/* PromptVeil offscreen document.
 * MV3 service workers have no DOM, so they can't write to the clipboard. The service worker opens
 * this hidden extension page (reason CLIPBOARD) only to copy restored text, then closes it again.
 * It accepts messages only from PromptVeil's own service worker: content scripts and other pages
 * that broadcast runtime messages are ignored.
 */
"use strict";

const WORKER_URL = chrome.runtime.getURL("background.js");
const fromWorker = sender => sender.id === chrome.runtime.id && sender.url === WORKER_URL && !sender.tab;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false; // meant for the service worker, not us
  if (!fromWorker(sender) || msg.type !== "clipboard-write" || typeof msg.text !== "string") {
    sendResponse({ ok: false });
    return false;
  }
  // navigator.clipboard needs document focus, which an offscreen document never has, so use the
  // textarea + execCommand("copy") route (needs the clipboardWrite permission).
  const buf = document.getElementById("buf");
  let ok = false;
  try {
    buf.value = msg.text;
    buf.select();
    ok = document.execCommand("copy");
  } catch (_) {
    ok = false;
  } finally {
    buf.value = "";
  }
  sendResponse({ ok });
  return false;
});
