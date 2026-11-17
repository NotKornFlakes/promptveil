"""End-to-end test: loads the unpacked extension in Chrome and pastes into stand-in AI chat pages.
Run: python3 scripts/build_extension.py && python3 tests/extension_e2e.py  (needs playwright + Chrome for Testing)
"""
import os, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = str(ROOT / "extension")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
SHOTS = Path(os.environ.get("SHOTS", "/tmp/shots"))
SHOTS.mkdir(exist_ok=True)

SECRET = ("Client Riverside Dental, manager Marcus Bell (marcus.bell@riversidedental.com, 404-555-0142).\n"
          "Server fileserver.lan at 192.168.10.25, password: Winter2026!\nCard 5555 5555 5555 4444")
RAW = ["marcus.bell@riversidedental.com", "404-555-0142", "fileserver.lan", "192.168.10.25", "Winter2026!", "5555 5555 5555 4444", "Marcus Bell"]
REAL = RAW + ["Riverside Dental"]  # every real value in the vault, including TERM_1

# An AI answer that uses the placeholders from SECRET, and what it should restore to.
ANSWER = "Hi [TERM_2],\nWe'll be at [TERM_1] Tuesday to fix [HOST_1] ([IP_1]). Reply to EMAIL_1."
RESTORED = ("Hi Marcus Bell,\nWe'll be at Riverside Dental Tuesday to fix fileserver.lan (192.168.10.25). "
            "Reply to marcus.bell@riversidedental.com.")

# Stand-in for chatgpt.com: a plain <textarea>.
TEXTAREA_PAGE = "<html><body><textarea id=box rows=8 cols=80></textarea></body></html>"
# Stand-in for claude.ai: a contenteditable rich editor that handles paste itself (like ProseMirror)
# and logs everything it ever received so we can prove raw data never reached the page.
RICH_PAGE = """<html><body><div id=ed contenteditable=true style="min-height:80px;border:1px solid #999"></div>
<script>
window.seen = [];
document.getElementById('ed').addEventListener('paste', e => {
  const t = e.clipboardData.getData('text/plain'); window.seen.push(t); e.preventDefault();
  document.execCommand('insertText', false, t);
});
</script></body></html>"""

# Stand-in for a ChatGPT conversation: a user turn, two answers that must not get a button
# (no placeholders / placeholders that aren't in the vault) and a stream() helper that types an
# answer in piece by piece. window.seen logs every bit of text the page could observe in its DOM.
ANSWERS_PAGE = """<html><body>
<div data-message-author-role="user" id="u1">My question about [TERM_2]</div>
<div data-message-author-role="assistant" id="a1">A plain answer with nothing to restore.</div>
<div data-message-author-role="assistant" id="a2">Unknown placeholders: [EMAIL_99] and IP_42.</div>
<div id="thread"></div>
<script>
window.seen = [];
new MutationObserver(rs => { for (const r of rs) {
  if (r.type === 'characterData') seen.push(r.target.data);
  if (r.type === 'attributes') seen.push(String(r.target.getAttribute(r.attributeName)));
  for (const n of r.addedNodes) seen.push(n.textContent || '');
}}).observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true});
window.stream = text => {
  const d = document.createElement('div'); d.id = 'a3'; d.style.whiteSpace = 'pre-wrap';
  d.setAttribute('data-message-author-role', 'assistant'); document.getElementById('thread').appendChild(d);
  let i = 0; const t = setInterval(() => { d.append(text.slice(i, i + 6)); i += 6; if (i >= text.length) clearInterval(t); }, 25);
};
</script></body></html>"""

def page_paste(pg, selector, text):
    """Dispatch a paste event from the *page* world, like a browser paste does."""
    pg.focus(selector)
    pg.evaluate("""([sel, text]) => { const dt = new DataTransfer(); dt.setData('text/plain', text);
        document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }""",
        [selector, text])
    pg.wait_for_timeout(400)

def shadow_text(pg):
    """Text drawn inside PromptVeil's closed shadow roots (toast, buttons). CDP can pierce closed
    shadow roots; the page's own scripts can't."""
    cdp = pg.context.new_cdp_session(pg)
    try:
        root = cdp.send("DOM.getDocument", {"depth": -1, "pierce": True})["root"]
    finally:
        cdp.detach()
    out = []
    def walk(n, inside, parent):
        inside = inside or n.get("nodeName", "").lower().startswith("promptveil-")
        if inside and n.get("nodeType") == 3 and parent != "STYLE":
            out.append(n.get("nodeValue", ""))
        for c in n.get("children", []) + n.get("shadowRoots", []):
            walk(c, inside, n.get("nodeName"))
    walk(root, False, None)
    return " ".join(out)

def clipboard(plain):
    """Read the clipboard the way a user would: Ctrl+V into a page PromptVeil doesn't touch."""
    plain.bring_to_front()
    plain.fill("#box", "")
    plain.focus("#box"); plain.keyboard.press("Control+V"); plain.wait_for_timeout(300)
    return plain.input_value("#box")

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))
    if not cond: failures.append(name)

with sync_playwright() as p, tempfile.TemporaryDirectory() as prof:
    ctx = p.chromium.launch_persistent_context(prof, executable_path=CHROME, headless=False,
        args=["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        viewport={"width": 1100, "height": 700})
    ctx.route("https://chatgpt.com/**", lambda r: r.fulfill(
        body=ANSWERS_PAGE if "/c/answers" in r.request.url else TEXTAREA_PAGE, content_type="text/html"))
    ctx.route("https://claude.ai/**", lambda r: r.fulfill(body=RICH_PAGE, content_type="text/html"))
    ctx.route("https://example.com/**", lambda r: r.fulfill(body=TEXTAREA_PAGE, content_type="text/html"))
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    sw.evaluate("chrome.storage.local.set({terms: ['Marcus Bell', 'Riverside Dental']})")

    # 1. textarea (ChatGPT-style)
    pg = ctx.new_page(); pg.goto("https://chatgpt.com/c/test"); pg.wait_for_timeout(300)
    page_paste(pg, "#box", SECRET)
    val = pg.input_value("#box")
    check("textarea: raw values removed", not any(r in val for r in RAW), val)
    check("textarea: placeholders inserted", "[EMAIL_1]" in val and "[TERM_2]" in val and "[CARD_1]" in val, val)
    pg.screenshot(path=str(SHOTS / "ext_textarea.png"))

    # 2. rich editor (Claude-style): page's own paste handler must only ever see scrubbed text
    pg2 = ctx.new_page(); pg2.goto("https://claude.ai/new"); pg2.wait_for_timeout(300)
    page_paste(pg2, "#ed", SECRET)
    seen = pg2.evaluate("window.seen")
    txt = pg2.inner_text("#ed")
    check("rich editor: page handler never saw raw data", seen and not any(r in s for s in seen for r in RAW), seen)
    check("rich editor: scrubbed text inserted", "[EMAIL_1]" in txt and "[IP_1]" in txt, txt)
    check("rich editor: line breaks kept", txt.count("\n") >= 2, repr(txt))

    # 3. consistency across pastes in the same session
    page_paste(pg2, "#ed", "\nalso cc marcus.bell@riversidedental.com and 10.9.9.9")
    txt = pg2.inner_text("#ed")
    check("same value -> same placeholder across pastes", "cc [EMAIL_1] and [IP_2]" in txt, txt)
    pg2.screenshot(path=str(SHOTS / "ext_rich.png"))

    # 4. real keyboard paste (Ctrl+V) from the system clipboard
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="https://chatgpt.com")
    pg.fill("#box", "")
    pg.evaluate("t => navigator.clipboard.writeText(t)", "key AKIAIOSFODNN7EXAMPLE on 10.0.4.12")
    pg.focus("#box"); pg.keyboard.press("Control+V"); pg.wait_for_timeout(400)
    val = pg.input_value("#box")
    check("real Ctrl+V is scrubbed", val == "key [AWS_KEY_1] on [IP_3]", val)

    # 5. sites outside the list are untouched
    pg3 = ctx.new_page(); pg3.goto("https://example.com/"); pg3.wait_for_timeout(300)
    page_paste(pg3, "#box", "bob@x.io")
    check("non-AI site untouched", pg3.input_value("#box") == "", pg3.input_value("#box"))

    # 6. per-site off switch
    sw.evaluate("chrome.storage.local.set({disabledSites: ['chatgpt.com']})"); pg.wait_for_timeout(200)
    pg.fill("#box", "")
    page_paste(pg, "#box", "raw@x.io")
    check("disabled site: content script stands down", pg.input_value("#box") == "", pg.input_value("#box"))
    sw.evaluate("chrome.storage.local.set({disabledSites: []})")

    # 7. vault lives in session storage (memory), not local storage (disk)
    local = sw.evaluate("chrome.storage.local.get(null)")
    sess = sw.evaluate("chrome.storage.session.get(null)")
    check("vault in session storage", "EMAIL_1" in sess.get("mapping", {}), sess)
    check("no real values in local storage", "mapping" not in local and "Winter2026!" not in str(local), local)

    # 8. popup restore
    pop = ctx.new_page(); pop.set_viewport_size({"width": 400, "height": 640})
    pop.goto(f"chrome-extension://{ext_id}/popup.html")
    answer = "Hi [TERM_2],\nWe'll be at [TERM_1] Tuesday to fix [HOST_1] ([IP_1]). Reply to EMAIL_1."
    pop.fill("#restoreIn", answer); pop.dispatch_event("#restoreIn", "input"); pop.wait_for_timeout(300)
    out = pop.inner_text("#restoreOut")
    check("popup restores values", out == "Hi Marcus Bell,\nWe'll be at Riverside Dental Tuesday to fix fileserver.lan (192.168.10.25). Reply to marcus.bell@riversidedental.com.", out)
    pop.screenshot(path=str(SHOTS / "ext_popup_restore.png"))
    pop.click("nav button[data-tab=vault]"); pop.wait_for_timeout(200)
    pop.screenshot(path=str(SHOTS / "ext_popup_vault.png"))
    pop.click("nav button[data-tab=settings]"); pop.wait_for_timeout(200)
    pop.screenshot(path=str(SHOTS / "ext_popup_settings.png"))

    # 9. the AI page can't reach the extension, and the content script can't pull real values out
    pg2b = ctx.new_page()
    cdp = ctx.new_cdp_session(pg2b)
    contexts = []
    cdp.on("Runtime.executionContextCreated", lambda e: contexts.append(e["context"]))
    cdp.send("Runtime.enable")
    pg2b.goto("https://claude.ai/new"); pg2b.wait_for_timeout(500)
    check("page world has no extension messaging", pg2b.evaluate("typeof (window.chrome && chrome.runtime && chrome.runtime.sendMessage)") == "undefined")
    iso = [c for c in contexts if c.get("auxData", {}).get("type") == "isolated" and "PromptVeil" in c.get("name", "")]
    check("found content-script world", bool(iso), [c.get("name") for c in contexts])
    if iso:
        def in_cs(expr):
            r = cdp.send("Runtime.evaluate", {"expression": expr, "contextId": iso[-1]["id"], "awaitPromise": True, "returnByValue": True})
            return r["result"].get("value")
        r1 = in_cs("chrome.runtime.sendMessage({type:'restore', text:'[EMAIL_1]'})")
        r2 = in_cs("chrome.runtime.sendMessage({type:'vault'})")
        check("content script refused restore", isinstance(r1, dict) and "error" in r1 and "marcus" not in str(r1), r1)
        check("content script refused vault", isinstance(r2, dict) and "error" in r2 and "mapping" not in r2, r2)
        r3 = in_cs("chrome.runtime.sendMessage({type:'has', text:'see [EMAIL_1]'})")
        check("content script 'has' gets yes/no only", r3 == {"found": True}, r3)
        r4 = in_cs("chrome.runtime.sendMessage({type:'copyRestored', text:'mail [EMAIL_1]'})")
        check("content script 'copyRestored' gets a count only", r4 == {"count": 1}, r4)
        r5 = in_cs("chrome.runtime.sendMessage({type:'has', text: 'x'.repeat(1000001)})")
        check("oversized text refused", isinstance(r5, dict) and "error" in r5, r5)

    # 10. "Copy with real values" button on AI answers
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="https://example.com")
    pa = ctx.new_page(); pa.goto("https://chatgpt.com/c/answers"); pa.wait_for_timeout(800)
    check("button: none on answers without known placeholders", pa.locator("promptveil-copy").count() == 0,
          pa.locator("promptveil-copy").count())
    pa.evaluate("t => stream(t)", ANSWER)
    try:
        pa.wait_for_selector("#a3 promptveil-copy", state="attached", timeout=5000); appeared = True
    except Exception:
        appeared = False
    check("button: appears on a streamed answer with known placeholders", appeared)
    pa.wait_for_timeout(1500)  # let the stream finish and the observer settle
    check("button: only on that answer (not the user turn, plain or unknown-placeholder answers)",
          pa.locator("promptveil-copy").count() == 1 and pa.locator("#a3 promptveil-copy").count() == 1,
          pa.locator("promptveil-copy").count())
    pg3.evaluate("t => navigator.clipboard.writeText(t)", "sentinel")
    pa.evaluate("""() => { const h = document.querySelector('#a3 promptveil-copy'); h.click();
        h.dispatchEvent(new MouseEvent('click', {bubbles: true, composed: true})); }""")
    pa.wait_for_timeout(500)
    check("button: synthetic clicks from the page don't copy", clipboard(pg3) == "sentinel", clipboard(pg3))
    pa.bring_to_front()
    bb = pa.locator("#a3 promptveil-copy").bounding_box()
    pa.mouse.click(bb["x"] + 30, bb["y"] + bb["height"] / 2); pa.wait_for_timeout(800)
    shown = shadow_text(pa)
    check("button: toast says how many values were restored", "Copied with 5 real values restored" in shown, shown)
    pa.screenshot(path=str(SHOTS / "ext_copy_button.png"))
    got = clipboard(pg3)
    check("button: clipboard holds the restored answer", got == RESTORED, repr(got))
    dom = pa.content() + "\n".join(pa.evaluate("window.seen")) + pa.evaluate("document.body.innerText")
    check("button: real values never entered the page DOM", not any(r in dom for r in REAL),
          [r for r in REAL if r in dom])
    check("button: no real values in the toast or button", not any(r in shown for r in REAL), shown)
    check("offscreen document closed after copying",
          sw.evaluate("chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})") == [])

    # 11. Right-click "Restore real values with PromptVeil" copies right away; "Restore and view…"
    # opens the restore window. Playwright can't click Chrome's native context menu, so this calls
    # onMenuClick, the function the menu's onClicked listener runs, from the service worker.
    # The tab is the active one: the extension has no `tabs` permission, so it can't look up
    # non-AI tabs by URL.
    MENU = """async ([id, fallback]) => {
        const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
        return await onMenuClick({menuItemId: id, frameId: 0, selectionText: fallback}, tab);
    }"""
    pa.evaluate("""() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('u1'));
        getSelection().removeAllRanges(); getSelection().addRange(r); }""")
    pg3.evaluate("t => navigator.clipboard.writeText(t)", "sentinel")
    pages_before = len(ctx.pages)
    pa.bring_to_front()
    r = sw.evaluate(MENU, ["pv-restore", "My question about [TERM_2]"])
    check("right-click: restores and reports a count", r == {"count": 1}, r)
    check("right-click: opens no window", len(ctx.pages) == pages_before, len(ctx.pages))
    shown = shadow_text(pa)
    check("right-click: toast on the page", "Copied with 1 real value restored" in shown, shown)
    got = clipboard(pg3)
    check("right-click: clipboard holds the restored selection", got == "My question about Marcus Bell", repr(got))
    dom = pa.content() + "\n".join(pa.evaluate("window.seen"))
    check("right-click: real values never entered the page DOM", not any(x in dom for x in REAL), [x for x in REAL if x in dom])

    pa.bring_to_front()
    with ctx.expect_page() as win:
        sw.evaluate(MENU, ["pv-restore-view", ""])
    view = win.value; view.wait_for_load_state(); view.wait_for_timeout(400)
    check("Restore and view…: opens the restore window", "view=restore" in view.url, view.url)
    check("Restore and view…: shows the restored selection",
          view.inner_text("#restoreOut") == "My question about Marcus Bell", view.inner_text("#restoreOut"))
    view.close()

    # Outside the AI sites there's no content script and no host access: Chrome's selectionText is
    # used, and the toolbar badge shows the result instead of a toast.
    pg3.bring_to_front()
    r = sw.evaluate(MENU, ["pv-restore", "ping [IP_1]"])
    badge = sw.evaluate("""async () => { const [t] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
        return chrome.action.getBadgeText({tabId: t.id}); }""")
    check("right-click on other sites: copies and shows the count on the badge", r == {"count": 1} and badge == "1", [r, badge])
    got = clipboard(pg3)
    check("right-click on other sites: clipboard holds the restored text", got == "ping 192.168.10.25", repr(got))
    check("right-click: nothing copied when nothing is known",
          sw.evaluate(MENU, ["pv-restore", "no placeholders here"]) == {"count": 0, "reason": "none"}
          and clipboard(pg3) == "ping 192.168.10.25")

    # Last, because it empties the vault: starting a new session removes the buttons.
    pop.click("nav button[data-tab=vault]"); pop.click("#reset"); pa.wait_for_timeout(1500)
    check("button: removed when the vault is reset", pa.locator("promptveil-copy").count() == 0,
          pa.locator("promptveil-copy").count())

    ctx.close()

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
