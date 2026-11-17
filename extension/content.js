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
  //   responses: one AI answer each (gets a "Copy with real values" button)
  //   send:      the send button (checked by the optional typed-text guard)
  //   input:     the chat box, used when Send is clicked and no box had focus yet
  // These are best guesses at each site's markup and are not verified against the live sites.
  // If `responses` matches nothing, no buttons appear and the right-click menu still works.
  // If `send` matches nothing, GENERIC_SEND is tried, and Enter is guarded either way.
  const SITES = {
    "chatgpt.com": { responses: '[data-message-author-role="assistant"]',
      send: '#composer-submit-button, button[data-testid="send-button"]', input: "#prompt-textarea" },
    "chat.openai.com": { responses: '[data-message-author-role="assistant"]',
      send: '#composer-submit-button, button[data-testid="send-button"]', input: "#prompt-textarea" },
    "claude.ai": { responses: ".font-claude-response, .font-claude-message",
      send: 'button[aria-label="Send message"], button[aria-label="Send Message"]', input: '.ProseMirror[contenteditable="true"]' },
    "gemini.google.com": { responses: "message-content",
      send: 'button.send-button, button[aria-label="Send message"]', input: 'rich-textarea [contenteditable="true"]' },
    "copilot.microsoft.com": { responses: '[data-content="ai-message"]',
      send: 'button[data-testid="submit-button"], button[aria-label="Submit message"]', input: "textarea" },
    "www.perplexity.ai": { responses: '[id^="markdown-content-"]',
      send: 'button[aria-label="Submit"]', input: '#ask-input, textarea' },
    "chat.deepseek.com": { responses: ".ds-markdown", input: "textarea" },
    "chat.mistral.ai": { responses: '[data-message-author-role="assistant"]',
      send: 'button[type="submit"]', input: 'textarea, [contenteditable="true"]' },
    "grok.com": { responses: ".response-content-markdown",
      send: 'button[type="submit"]', input: 'textarea, [contenteditable="true"]' },
  };
  const GENERIC_SEND = 'button[type="submit"], button[aria-label*="send" i], button[data-testid*="send" i]';
  const MAX_TEXT = 1_000_000; // same cap as the service worker

  const host = location.hostname;
  const SITE = SITES[host] || {};
  let enabled = true;
  const ours = new WeakSet(); // synthetic paste events we dispatched ourselves

  let guardOn = false;             // "Check typed text before sending" (off by default)

  chrome.storage.local.get({ disabledSites: [], guardTyped: false }).then(s => {
    guardOn = s.guardTyped === true;
    setEnabled(!s.disabledSites.includes(host));
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.guardTyped) guardOn = ch.guardTyped.newValue === true;
    if (ch.disabledSites) setEnabled(!(ch.disabledSites.newValue || []).includes(host));
  });
  function setEnabled(on) {
    enabled = on;
    if (on) { gen++; schedule(); } else removeAllButtons();
  }

  // Messages from PromptVeil's service worker (never from the page or other content scripts).
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !msg) return;
    if (msg.type === "vault-changed") { gen++; schedule(); }
    // Result of a right-click restore or the shortcut. The worker never puts real values in it.
    if (msg.type === "toast" && typeof msg.title === "string" && typeof msg.detail === "string") {
      toast(msg.title.slice(0, 200), msg.detail.slice(0, 300), msg.bad === true);
    }
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
    // Only real pastes by the user. A page could otherwise dispatch its own paste events with
    // guessed values and watch which placeholder comes back (placeholders are reused for known
    // values), learning what's in the vault. A synthetic paste inserts nothing by itself.
    if (!enabled || ours.has(e) || !e.isTrusted) return;
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

  // --- optional: check typed text before it's sent --------------------------------------
  // Off by default. While you type, the chat box text is sent to the service worker, which
  // answers with counts only (the word lists stay in the worker). On Enter or Send, a message
  // with sensitive items is blocked once and a toast offers to hide them. Sending the same text
  // again goes through: that's your call. If the check fails, the send is blocked (fail closed).
  const SEND_SELECTOR = [SITE.send, GENERIC_SEND].filter(Boolean).join(", ");
  let lastScan = { text: null, result: null, pending: null };
  let allowOnce = null; // text the user already chose to send anyway
  let lastBox = null;   // the chat box the user last typed in

  const isField = el => el.tagName === "TEXTAREA" || el.tagName === "INPUT";
  const boxText = el => (isField(el) ? el.value : el.innerText || "");
  const plural = n => (n === 1 ? "" : "s");
  const countsText = counts => counts.map(c => `${c.n} ${c.label}`).join(" · ");

  function scanText(text) {
    if (lastScan.text === text && (lastScan.result || lastScan.pending)) return lastScan.pending || Promise.resolve(lastScan.result);
    const entry = { text, result: null, pending: null };
    entry.pending = chrome.runtime.sendMessage({ type: "scan", text }).then(r => {
      if (!r || r.error || typeof r.total !== "number" || !Array.isArray(r.counts)) throw new Error("scan failed");
      entry.result = r;
      entry.pending = null;
      return r;
    });
    entry.pending.catch(() => { if (lastScan === entry) lastScan = { text: null, result: null, pending: null }; });
    lastScan = entry;
    return entry.pending;
  }

  function findBox() {
    if (lastBox && lastBox.isConnected) return lastBox;
    try { return SITE.input ? editableFrom(document.querySelector(SITE.input)) : null; } catch (_) { return null; }
  }
  function findSendButton(box) {
    try {
      const form = box.closest("form");
      return (form && form.querySelector(SEND_SELECTOR)) || document.querySelector(SEND_SELECTOR);
    } catch (_) { return null; }
  }
  const block = e => { e.preventDefault(); e.stopImmediatePropagation(); };

  function offerHide(box, text, r) {
    allowOnce = text;
    toast(`Found ${r.total} sensitive item${plural(r.total)}`, `${countsText(r.counts)}. Not sent. Send again to send it as is.`, true,
      { label: `Hide ${r.total} item${plural(r.total)}`, run: () => hideInBox(box) });
  }

  // Called for trusted Enter presses and Send clicks. `resend` repeats the send after an
  // in-flight check comes back clean.
  function guardSend(e, box, resend) {
    if (!guardOn || !enabled || !e.isTrusted || !box) return;
    const text = boxText(box);
    if (!text.trim() || text === allowOnce) return;
    if (text.length > MAX_TEXT) {
      block(e);
      allowOnce = text;
      toast("Too long to check", "Not sent. Send again to send it as is.", true);
      return;
    }
    if (lastScan.text === text && lastScan.result) {
      if (lastScan.result.total) { block(e); offerHide(box, text, lastScan.result); }
      return; // clean: let the site send it
    }
    block(e); // not checked yet (you pressed Enter mid-check): hold it until the answer is in
    scanText(text).then(r => {
      if (boxText(box) !== text) return; // you kept typing
      if (r.total) offerHide(box, text, r);
      else resend();
    }, () => {
      allowOnce = text;
      toast("Couldn't check this message", "PromptVeil stopped it. Send again to send it as is.", true);
    });
  }

  function hideInBox(box) {
    if (!box.isConnected) return;
    const text = boxText(box);
    chrome.runtime.sendMessage({ type: "scrub", text }).then(r => {
      if (!r || r.error || typeof r.text !== "string") throw new Error("scrub failed");
      // Select everything in the box and put the scrubbed text in its place, the same way a
      // paste is inserted, so the site's editor updates its own state.
      box.focus();
      if (isField(box)) box.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(box);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      insert(box, box, r.text);
      allowOnce = null;
      toast(`Hid ${r.total} item${plural(r.total)}`, `${countsText(r.counts)}. Review it, then send.`);
    }).catch(() => {
      toast("Couldn't hide", "Nothing was sent. Edit the message, or turn PromptVeil off for this site.", true);
    });
  }

  window.addEventListener("focusin", e => { const b = editableFrom(e.target); if (b) lastBox = b; }, true);
  window.addEventListener("input", e => {
    if (!guardOn || !enabled) return;
    const box = editableFrom(e.target);
    if (!box) return;
    lastBox = box;
    const text = boxText(box);
    if (text !== allowOnce) allowOnce = null;
    if (text.trim() && text.length <= MAX_TEXT) scanText(text).catch(() => {});
  }, true);
  window.addEventListener("keydown", e => {
    // Shift+Enter (new line), Alt+Enter and IME composition are left alone.
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    const box = editableFrom(e.target);
    if (!box) return;
    guardSend(e, box, () => {
      const btn = findSendButton(box);
      if (btn) btn.click();
      else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    });
  }, true);
  window.addEventListener("click", e => {
    if (!guardOn || !enabled || !e.isTrusted || !(e.target instanceof Element)) return;
    let btn = null;
    try { btn = e.target.closest(SEND_SELECTOR); } catch (_) { return; }
    if (!btn) return;
    guardSend(e, findBox(), () => btn.click());
  }, true);

  // --- toast (closed shadow root so the page can't style or read it) --------------------
  const TOAST_CSS = `
    .t{position:fixed;z-index:2147483647;right:18px;bottom:18px;max-width:340px;font:13px/1.4 system-ui,sans-serif;
       background:#0d1117;color:#e6edf3;border:1px solid #2a333f;border-left:4px solid #4fd1a5;border-radius:10px;
       padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:.18s;pointer-events:none}
    .t.show{opacity:1;transform:none}.t.bad{border-left-color:#ff7b72}.t.act.show{pointer-events:auto}
    b{display:block;font-size:13.5px}span{color:#8b98a7}
    button{display:none;margin-top:8px;font:600 12.5px system-ui,sans-serif;color:#06261b;background:#4fd1a5;
       border:0;border-radius:7px;padding:6px 11px;cursor:pointer}
    .t.act button{display:inline-block}button:focus-visible{outline:2px solid #e6edf3;outline-offset:2px}`;
  let toastHost, box, titleEl, detailEl, actionEl, toastTimer, toastAction = null;
  function toast(title, detail, bad, action) {
    if (!toastHost) {
      toastHost = document.createElement("promptveil-toast");
      const root = toastHost.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = TOAST_CSS;
      box = document.createElement("div");
      box.className = "t";
      box.setAttribute("role", "status");
      titleEl = document.createElement("b");
      detailEl = document.createElement("span");
      actionEl = document.createElement("button");
      actionEl.type = "button";
      actionEl.addEventListener("click", e => {
        e.stopPropagation();
        if (!e.isTrusted || !toastAction) return; // only a real click on our own button
        const run = toastAction;
        toastAction = null;
        box.classList.remove("show", "act");
        run();
      });
      box.append(titleEl, detailEl, actionEl);
      root.append(style, box);
    }
    if (!toastHost.isConnected) (document.body || document.documentElement).appendChild(toastHost);
    titleEl.textContent = "🛡 PromptVeil · " + title;
    detailEl.textContent = detail;
    toastAction = action ? action.run : null;
    actionEl.textContent = action ? action.label : "";
    box.classList.toggle("bad", !!bad);
    box.classList.toggle("act", !!action);
    box.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.classList.remove("show", "act"); toastAction = null; }, action ? 12000 : bad ? 6000 : 3500);
  }
})();
