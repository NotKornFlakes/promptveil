/* PromptVeil content script: scrubs text pasted into AI chat boxes.
 * Runs in the extension's isolated world. It never receives real values back. It only
 * swaps what you paste for the scrubbed version. If scrubbing fails it blocks the paste
 * (fail closed) instead of letting raw data through.
 */
(() => {
  "use strict";
  if (window.__promptveil) return;
  window.__promptveil = true;

  const host = location.hostname;
  let enabled = true;
  const ours = new WeakSet(); // synthetic paste events we dispatched ourselves

  chrome.storage.local.get({ disabledSites: [] }).then(s => { enabled = !s.disabledSites.includes(host); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.disabledSites) enabled = !(ch.disabledSites.newValue || []).includes(host);
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

  // --- toast (closed shadow root so the page can't style or read it) --------------------
  let box, timer;
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
    clearTimeout(timer);
    timer = setTimeout(() => box.classList.remove("show"), bad ? 6000 : 3500);
  }
})();
