/* PromptVeil content script: scrubs text pasted into AI chat boxes.
 * Runs in the extension's isolated world. It never receives real values back. It only
 * swaps what you paste for the scrubbed version. If scrubbing fails it blocks the paste
 * (fail closed) instead of letting raw data through.
 * It also adds a "Copy with real values" button to AI answers that contain known placeholders.
 * The button sends the answer (placeholders only) to the service worker, which restores it and
 * writes it to the clipboard itself. The real values never come back to this script or the page.
 */
(() => {
  "use strict";
  if (window.__promptveil) return;
  window.__promptveil = true;

  // Per-site selectors, kept in one place because sites change their markup often.
  // `responses` matches one AI answer each. These are best guesses at each site's markup and are
  // not verified against the live sites: if a selector matches nothing, no buttons appear and the
  // right-click menu still works.
  const SITES = {
    "chatgpt.com": { responses: '[data-message-author-role="assistant"]' },
    "chat.openai.com": { responses: '[data-message-author-role="assistant"]' },
    "claude.ai": { responses: ".font-claude-response, .font-claude-message" },
    "gemini.google.com": { responses: "message-content" },
    "copilot.microsoft.com": { responses: '[data-content="ai-message"]' },
    "www.perplexity.ai": { responses: '[id^="markdown-content-"]' },
    "chat.deepseek.com": { responses: ".ds-markdown" },
    "chat.mistral.ai": { responses: '[data-message-author-role="assistant"]' },
    "grok.com": { responses: ".response-content-markdown" },
  };
  const MAX_TEXT = 1_000_000; // same cap as the service worker

  const host = location.hostname;
  const SITE = SITES[host] || {};
  let enabled = true;
  const ours = new WeakSet(); // synthetic paste events we dispatched ourselves

  chrome.storage.local.get({ disabledSites: [] }).then(s => { setEnabled(!s.disabledSites.includes(host)); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.disabledSites) setEnabled(!(ch.disabledSites.newValue || []).includes(host));
  });
  function setEnabled(on) {
    enabled = on;
    if (on) { gen++; schedule(); } else removeAllButtons();
  }

  // Messages from PromptVeil's service worker (never from the page or other content scripts).
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !msg) return;
    if (msg.type === "vault-changed") { gen++; schedule(); }
  });

  function editableFrom(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el) return null;
    const field = el.closest("textarea, input");
    if (field) {
      const t = (field.getAttribute("type") || "text").toLowerCase();
      return field.tagName === "TEXTAREA" || ["text", "search", ""].includes(t) ? field : null;
    }
    return el.isContentEditable ? el : null;
  }

  function insert(target, origin, text) {
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      target.focus();
      if (!document.execCommand("insertText", false, text)) {
        const s = target.selectionStart, e = target.selectionEnd;
        target.setRangeText(text, s, e, "end");
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
      }
      return;
    }
    // Rich editors (ProseMirror, Lexical, Quill…) handle their own paste events best,
    // so hand them a paste event carrying the scrubbed text.
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    ours.add(ev);
    (origin.isConnected ? origin : target).dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      target.focus();
      document.execCommand("insertText", false, text);
    }
  }

  function onPaste(e) {
    if (!enabled || ours.has(e)) return;
    const target = editableFrom(e.target);
    if (!target || !e.clipboardData) return;
    if (e.clipboardData.files && e.clipboardData.files.length) return; // images/files: leave alone
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    const origin = e.target;

    chrome.runtime.sendMessage({ type: "scrub", text }).then(r => {
      if (!r || r.error) throw new Error(r && r.error);
      insert(target, origin, r.text);
      if (r.total) toast(`Hid ${r.total} item${r.total === 1 ? "" : "s"}`, r.counts.map(c => `${c.n} ${c.label}`).join(" · "));
    }).catch(() => {
      toast("Paste blocked", "PromptVeil couldn't scrub this text. Reload the page, or turn PromptVeil off for this site.", true);
    });
  }
  window.addEventListener("paste", onPaste, true);

  // --- "Copy with real values" buttons on AI answers -----------------------------------
  const BUTTON_TAG = "promptveil-copy";
  const OUR_TAGS = new Set([BUTTON_TAG.toUpperCase(), "PROMPTVEIL-TOAST"]);
  const LOOKS_LIKE_PLACEHOLDER = /\b[A-Z][A-Z0-9_]*_\d+\b/; // cheap local check before asking the worker
  const checked = new WeakMap(); // answer element -> { text, gen, found }
  const buttons = new WeakMap(); // answer element -> button host element
  const hosts = new Set();       // live button hosts, so they can all be removed
  let gen = 0;                   // bumped when the vault changes, forcing a re-check
  let copying = false;           // one copy request at a time

  const answerText = el => el.innerText || el.textContent || "";

  function scan() {
    if (!enabled || !SITE.responses) return;
    for (const h of hosts) if (!h.isConnected) hosts.delete(h);
    let nodes;
    try { nodes = document.querySelectorAll(SITE.responses); } catch (_) { return; } // bad selector: no buttons
    for (const el of nodes) {
      if (el.parentElement && el.parentElement.closest(SITE.responses)) continue; // nested match: outer one wins
      const text = answerText(el);
      const prev = checked.get(el);
      if (prev && prev.text === text && prev.gen === gen) {
        if (prev.found) addButton(el); // re-add if the site re-rendered it away
        continue;
      }
      const entry = { text, gen, found: false };
      checked.set(el, entry);
      if (text.length > MAX_TEXT || !LOOKS_LIKE_PLACEHOLDER.test(text)) { removeButton(el); continue; }
      chrome.runtime.sendMessage({ type: "has", text }).then(r => {
        if (checked.get(el) !== entry) return; // the answer changed while we were asking
        entry.found = !!(r && r.found === true);
        if (entry.found && enabled) addButton(el); else removeButton(el);
      }, () => {});
    }
  }

  const BUTTON_CSS = `
    :host{display:block;margin:8px 0 2px}
    button{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;cursor:pointer;
      font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6edf3;background:#0d1117;
      border:1px solid #2a333f;border-radius:999px;padding:6px 10px}
    button:hover{border-color:#4fd1a5}
    button:focus-visible{outline:2px solid #4fd1a5;outline-offset:2px}
    button:disabled{opacity:.6;cursor:progress}`;

  function addButton(el) {
    const existing = buttons.get(el);
    if (existing && existing.parentNode === el) return;
    if (existing) hosts.delete(existing);
    const hostEl = document.createElement(BUTTON_TAG);
    const root = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = BUTTON_CSS;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🛡 Copy with real values";
    btn.title = "PromptVeil restores the placeholders and copies the answer. The real values never go into this page.";
    btn.addEventListener("click", e => onCopyClick(e, el, btn));
    root.append(style, btn);
    el.appendChild(hostEl);
    buttons.set(el, hostEl);
    hosts.add(hostEl);
  }

  function removeButton(el) {
    const h = buttons.get(el);
    if (!h) return;
    h.remove();
    hosts.delete(h);
    buttons.delete(el);
  }

  function removeAllButtons() {
    for (const h of hosts) h.remove();
    hosts.clear();
  }

  function onCopyClick(e, el, btn) {
    e.preventDefault();
    e.stopPropagation();
    // Only a real user click on our own button may trigger a copy: never page scripts,
    // synthetic events or the MutationObserver. One request per click, one at a time.
    if (!e.isTrusted || copying) return;
    const text = answerText(el);
    if (text.length > MAX_TEXT) { toast("Too long to copy", "Select part of the answer and use right-click → Restore.", true); return; }
    copying = true;
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: "copyRestored", text }).then(r => {
      if (!r || r.error) throw new Error("copy failed");
      if (r.count) {
        toast(`Copied with ${r.count} real value${r.count === 1 ? "" : "s"} restored`, "Paste it wherever you need it. This page never saw them.");
      } else {
        toast("Nothing to restore", r.reason === "empty"
          ? "The vault is empty. It's cleared when the browser closes or you start a new session."
          : "This answer has no placeholders PromptVeil knows.", true);
        removeButton(el);
      }
    }).catch(() => {
      toast("Couldn't copy", "Select the answer, right-click → Restore and view…", true);
    }).finally(() => {
      copying = false;
      btn.disabled = false;
    });
  }

  // Answers stream in, so re-scan after the page has been quiet for a moment, but at least
  // every 1.5 s while it keeps changing.
  let timer = 0, firstPending = 0;
  function schedule() {
    if (!SITE.responses) return;
    const now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(timer);
    timer = setTimeout(() => { firstPending = 0; scan(); }, Math.max(0, Math.min(300, firstPending + 1500 - now)));
  }
  const onlyOurs = r => r.type === "childList" &&
    [...r.addedNodes, ...r.removedNodes].every(n => OUR_TAGS.has(n.nodeName));
  if (SITE.responses) {
    new MutationObserver(records => {
      if (records.some(r => !onlyOurs(r))) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    schedule();
  }

  // --- toast (closed shadow root so the page can't style or read it) --------------------
  let box, toastTimer;
  function toast(title, detail, bad) {
    if (!box) {
      const hostEl = document.createElement("promptveil-toast");
      const root = hostEl.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        .t{position:fixed;z-index:2147483647;right:18px;bottom:18px;max-width:340px;font:13px/1.4 system-ui,sans-serif;
           background:#0d1117;color:#e6edf3;border:1px solid #2a333f;border-left:4px solid #4fd1a5;border-radius:10px;
           padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:.18s;pointer-events:none}
        .t.show{opacity:1;transform:none}.t.bad{border-left-color:#ff7b72}
        b{display:block;font-size:13.5px}span{color:#8b98a7}</style><div class="t"><b></b><span></span></div>`;
      box = root.querySelector(".t");
      (document.body || document.documentElement).appendChild(hostEl);
    }
    box.querySelector("b").textContent = "🛡 PromptVeil · " + title;
    box.querySelector("span").textContent = detail;
    box.classList.toggle("bad", !!bad);
    box.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove("show"), bad ? 6000 : 3500);
  }
})();
