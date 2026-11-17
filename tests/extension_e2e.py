"""End-to-end test: loads the unpacked extension in Chrome and pastes into stand-in AI chat pages.
Run: python3 scripts/build_extension.py && python3 tests/extension_e2e.py  (needs playwright + Chrome for Testing)
"""
import base64, json, os, sys, tempfile
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
window.sent = [];  // what the site would send: Enter (without Shift) sends and clears the editor
document.getElementById('ed').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sent.push(e.target.innerText); e.target.textContent = ''; }
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

# Stand-in for the ChatGPT composer: Enter (without Shift) or the Send button sends and clears.
COMPOSE_PAGE = """<html><body><textarea id="box" rows="4" cols="60"></textarea>
<button data-testid="send-button" id="send">Send</button>
<script>
window.sent = [];
const box = document.getElementById('box');
box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sent.push(box.value); box.value = ''; } });
document.getElementById('send').addEventListener('click', () => { sent.push(box.value); box.value = ''; });
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

def click_shadow_button(pg, label):
    """Really click (trusted mouse event) a button inside PromptVeil's closed shadow roots."""
    cdp = pg.context.new_cdp_session(pg)
    try:
        root = cdp.send("DOM.getDocument", {"depth": -1, "pierce": True})["root"]
        found = []
        def walk(n):
            if n.get("nodeName") == "BUTTON" and any(label in c.get("nodeValue", "") for c in n.get("children", [])):
                found.append(n)
            for c in n.get("children", []) + n.get("shadowRoots", []):
                walk(c)
        walk(root)
        if not found:
            return False
        q = cdp.send("DOM.getBoxModel", {"nodeId": found[0]["nodeId"]})["model"]["border"]
    finally:
        cdp.detach()
    pg.mouse.click(sum(q[0::2]) / 4, sum(q[1::2]) / 4)
    return True

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
        body=ANSWERS_PAGE if "/c/answers" in r.request.url else COMPOSE_PAGE if "/c/compose" in r.request.url
        else TEXTAREA_PAGE, content_type="text/html"))
    ctx.route("https://claude.ai/**", lambda r: r.fulfill(body=RICH_PAGE, content_type="text/html"))
    ctx.route("https://example.com/**", lambda r: r.fulfill(body=TEXTAREA_PAGE, content_type="text/html"))
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]

    # 0. Welcome page: opened once on install, with a demo that never touches the real vault.
    for _ in range(30):
        welcome = [pg for pg in ctx.pages if pg.url == f"chrome-extension://{ext_id}/welcome.html"]
        if welcome: break
        ctx.pages[0].wait_for_timeout(100)
    check("welcome page opens once on install", len(welcome) == 1, [pg.url for pg in ctx.pages])
    if welcome:
        wp = welcome[0]; wp.wait_for_load_state(); wp.set_viewport_size({"width": 900, "height": 1400})
        wp.click("#sample"); wp.wait_for_timeout(200)
        scrubbed, restored = wp.inner_text("#demoScrubbed"), wp.inner_text("#demoRestored")
        check("welcome demo: scrubs the sample",
              all(x in scrubbed for x in ["[EMAIL_1]", "[PHONE_1]", "[HOST_1]", "[IP_1]", "[CARD_1]", "[API_KEY_1]"])
              and not any(x in scrubbed for x in ["dana.reyes@example.com", "10.0.4.12", "415-555-0134"]), scrubbed)
        check("welcome demo: restores the drafted answer",
              "dana.reyes@example.com" in restored and "10.0.4.12" in restored and "[" not in restored, restored)
        wp.fill("#demoAnswer", "Email EMAIL_1 about [HOST_1]."); wp.dispatch_event("#demoAnswer", "input")
        check("welcome demo: restores an edited answer",
              wp.inner_text("#demoRestored") == "Email dana.reyes@example.com about db01.corp.", wp.inner_text("#demoRestored"))
        wp.screenshot(path=str(SHOTS / "ext_welcome.png"), full_page=True)
        check("welcome demo: real vault untouched", sw.evaluate("chrome.storage.session.get(null)").get("mapping", {}) == {},
              sw.evaluate("chrome.storage.session.get(null)"))
        wp.close()

    # Word lists as older versions stored them (plain text), then the migration that runs at startup.
    sw.evaluate("chrome.storage.local.set({terms: ['Marcus Bell', 'Riverside Dental'], allow: []})")
    sw.evaluate("migrateLists()")
    local = sw.evaluate("chrome.storage.local.get(null)")
    check("migration: plain-text lists encrypted, plain copy deleted",
          "terms" not in local and "allow" not in local and local.get("lists", {}).get("mode") == "device"
          and "Marcus" not in json.dumps(local), local)

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
    check("no real values or list entries in local storage",
          "mapping" not in local and not any(x in json.dumps(local) for x in REAL), local)

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

    # 12. Keyboard shortcut. Key presses sent through CDP never reach Chrome's extension-shortcut
    # handling (onCommand doesn't fire in this setup), so this checks that Chrome registered the
    # shortcut, then calls onCommand, the function the onCommand listener runs.
    cmds = sw.evaluate("chrome.commands.getAll()")
    sc = next((c.get("shortcut") for c in cmds if c["name"] == "restore-selection"), None)
    check("shortcut: registered as Ctrl+Shift+Y", sc == "Ctrl+Shift+Y", cmds)
    pa.evaluate("""() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('u1'));
        getSelection().removeAllRanges(); getSelection().addRange(r); }""")
    pg3.evaluate("t => navigator.clipboard.writeText(t)", "sentinel")
    pa.bring_to_front()
    r = sw.evaluate("async () => onCommand('restore-selection', (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0])")
    check("shortcut: restores the selection", r == {"count": 1}, r)
    got = clipboard(pg3)
    check("shortcut: clipboard holds the restored selection", got == "My question about Marcus Bell", repr(got))
    r = sw.evaluate("async () => onCommand('restore-selection')")  # no tab given: uses the active tab (example.com now)
    badge = sw.evaluate("""async () => { const [t] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
        return chrome.action.getBadgeText({tabId: t.id}); }""")
    check("shortcut on other sites: says it can't read the selection, copies nothing",
          r == {"count": 0, "reason": "noaccess"} and badge == "!" and clipboard(pg3) == "My question about Marcus Bell", [r, badge])

    # 13. Optional "check typed text before sending" (send guard)
    pc = ctx.new_page(); pc.goto("https://chatgpt.com/c/compose"); pc.wait_for_timeout(300)
    sent = lambda pg: pg.evaluate("window.sent")
    pc.click("#box"); pc.keyboard.type("default off: mail bob@example.org"); pc.wait_for_timeout(300)
    pc.keyboard.press("Enter"); pc.wait_for_timeout(300)
    check("send guard: off by default", sent(pc) == ["default off: mail bob@example.org"], sent(pc))

    sw.evaluate("chrome.storage.local.set({guardTyped: true})"); pc.wait_for_timeout(300)
    pc.click("#box"); pc.keyboard.type("Ping ops@riverside.example"); pc.keyboard.press("Shift+Enter")
    pc.keyboard.type("and 10.20.30.40"); pc.wait_for_timeout(400)
    check("send guard: Shift+Enter still adds a new line",
          pc.input_value("#box") == "Ping ops@riverside.example\nand 10.20.30.40" and len(sent(pc)) == 1, pc.input_value("#box"))
    pc.keyboard.press("Enter"); pc.wait_for_timeout(500)
    shown = shadow_text(pc)
    check("send guard: Enter with sensitive text is blocked", len(sent(pc)) == 1, sent(pc))
    check("send guard: toast offers to hide them", "Hide 2 items" in shown, shown)
    pc.screenshot(path=str(SHOTS / "ext_send_guard.png"))
    check("send guard: Hide button clicked", click_shadow_button(pc, "Hide 2 items")); pc.wait_for_timeout(500)
    val = pc.input_value("#box")
    check("send guard: Hide replaces the box with scrubbed text",
          "[EMAIL_" in val and "[IP_" in val and "\n" in val and "ops@riverside.example" not in val and "10.20.30.40" not in val, val)
    pc.keyboard.press("Enter"); pc.wait_for_timeout(400)
    check("send guard: then the scrubbed message sends", sent(pc)[1:] == [val], sent(pc))

    pc.click("#box"); pc.keyboard.type("call 212-555-0199"); pc.wait_for_timeout(300)
    pc.keyboard.press("Enter"); pc.wait_for_timeout(300)
    blocked = len(sent(pc)) == 2
    pc.keyboard.press("Enter"); pc.wait_for_timeout(300)
    check("send guard: blocks once, sending again sends as is", blocked and sent(pc)[2:] == ["call 212-555-0199"], sent(pc))

    pc.click("#box"); pc.keyboard.type("key AKIAIOSFODNN7EXAMPLE"); pc.wait_for_timeout(300)
    pc.click("#send"); pc.wait_for_timeout(500)
    check("send guard: Send button is blocked too", len(sent(pc)) == 3 and "Hide 1 item" in shadow_text(pc), sent(pc))
    click_shadow_button(pc, "Hide 1 item"); pc.wait_for_timeout(500)
    pc.click("#send"); pc.wait_for_timeout(300)
    check("send guard: after Hide, Send sends the scrubbed text", sent(pc)[3:] == ["key [AWS_KEY_1]"], sent(pc))

    pc.click("#box"); pc.keyboard.type("hello there"); pc.wait_for_timeout(300); pc.keyboard.press("Enter"); pc.wait_for_timeout(300)
    check("send guard: clean text sends normally", sent(pc)[4:] == ["hello there"], sent(pc))

    # Enter pressed while the check is still running: the send is held, then repeated once the
    # check comes back clean, or turned into the Hide offer if it isn't. settings() is slowed
    # down in the worker so the check is guaranteed to still be running.
    sw.evaluate("""() => { self.__settings = settings;
        settings = async () => { await new Promise(r => setTimeout(r, 400)); return self.__settings(); }; }""")
    pc.click("#box"); pc.keyboard.type("held then sent"); pc.keyboard.press("Enter"); pc.wait_for_timeout(100)
    held = len(sent(pc)) == 5
    pc.wait_for_timeout(1200)
    check("send guard: Enter during a check is held, then sent when clean", held and sent(pc)[5:] == ["held then sent"], [held, sent(pc)])
    pc.click("#box"); pc.keyboard.type("held: 10.66.66.66"); pc.keyboard.press("Enter"); pc.wait_for_timeout(1200)
    check("send guard: Enter during a check is held, then blocked when sensitive",
          len(sent(pc)) == 6 and "Hide 1 item" in shadow_text(pc), sent(pc))
    sw.evaluate("() => { settings = self.__settings; }")
    pc.fill("#box", "")

    # Rich editor (Claude-style): Hide goes through the editor's own paste handling.
    pg2.bring_to_front()
    pg2.evaluate("() => { document.getElementById('ed').textContent = ''; window.seen = []; window.sent = []; }")
    pg2.click("#ed"); pg2.keyboard.type("ask Marcus Bell at marcus.bell@riversidedental.com"); pg2.wait_for_timeout(400)
    pg2.keyboard.press("Enter"); pg2.wait_for_timeout(500)
    check("send guard (rich editor): blocked", sent(pg2) == [], sent(pg2))
    click_shadow_button(pg2, "Hide 2 items"); pg2.wait_for_timeout(500)
    check("send guard (rich editor): Hide scrubs the editor, page only saw scrubbed text",
          pg2.inner_text("#ed") == "ask [TERM_2] at [EMAIL_1]" and pg2.evaluate("window.seen") == ["ask [TERM_2] at [EMAIL_1]"],
          [pg2.inner_text("#ed"), pg2.evaluate("window.seen")])
    pg2.keyboard.press("Enter"); pg2.wait_for_timeout(400)
    check("send guard (rich editor): then it sends", sent(pg2) == ["ask [TERM_2] at [EMAIL_1]"], sent(pg2))
    if iso:
        r6 = in_cs("chrome.runtime.sendMessage({type:'scan', text:'mail marcus.bell@riversidedental.com'})")
        check("content script 'scan' gets counts only", isinstance(r6, dict) and r6.get("total") == 1 and "marcus" not in str(r6), r6)
    sw.evaluate("chrome.storage.local.set({guardTyped: false})")

    # 14. Optional password lock for the word lists
    PW, PW2 = "correct horse battery", "staple gun velvet"
    lists = lambda: sw.evaluate("chrome.storage.local.get('lists')")["lists"]
    session = lambda: sw.evaluate("chrome.storage.session.get(null)")
    opt = ctx.new_page(); opt.goto(f"chrome-extension://{ext_id}/options.html"); opt.wait_for_timeout(300)
    opt.on("dialog", lambda d: d.accept())
    status_is = lambda pg, text: pg.wait_for_function(f"() => document.getElementById('lockStatus').textContent === {json.dumps(text)}", timeout=10000)
    check("options: password lock is off by default", opt.inner_text("#lockStatus") == "Off", opt.inner_text("#lockStatus"))
    opt.fill("#newPw", "short"); opt.fill("#newPw2", "short"); opt.click("#setGo"); opt.wait_for_timeout(300)
    check("options: passwords under 8 characters refused", "at least 8" in opt.inner_text("#lockMsg") and lists()["mode"] == "device",
          opt.inner_text("#lockMsg"))
    opt.fill("#newPw", PW); opt.fill("#newPw2", PW); opt.click("#setGo"); status_is(opt, "On · unlocked")
    l = lists()
    check("password lock: lists re-encrypted with PBKDF2-SHA256, 600,000 iterations, 16-byte salt",
          l["mode"] == "password" and l["kdf"]["name"] == "PBKDF2-SHA256" and l["kdf"]["iterations"] >= 600000
          and len(base64.b64decode(l["kdf"]["salt"])) == 16 and len(base64.b64decode(l["iv"])) == 12, l)
    check("password lock: the password is stored nowhere",
          PW not in json.dumps(sw.evaluate("chrome.storage.local.get(null)")) + json.dumps(session()))
    check("password lock: key kept in session memory while unlocked", "listKey" in session())
    if iso:
        r7 = in_cs("chrome.storage.session.get(null).then(() => 'readable', e => 'blocked')")
        check("session storage (vault, key) is closed to content scripts", r7 == "blocked", r7)
    iv_before = lists()["iv"]
    sw.evaluate("saveLists({terms: ['Marcus Bell', 'Riverside Dental'], allow: []})")
    check("password lock: fresh IV on every save", lists()["iv"] != iv_before)

    opt.click("#lockNow"); status_is(opt, "On · locked")
    check("lock: key forgotten", "listKey" not in session(), list(session()))
    pop.reload(); pop.wait_for_timeout(400)
    check("popup: shows 'Locked: unlock to use your custom terms'",
          pop.is_visible("#lockBanner") and pop.inner_text("#lockBanner").endswith("Locked: unlock to use your custom terms"))
    pop.screenshot(path=str(SHOTS / "ext_popup_locked.png"))
    pg.bring_to_front(); pg.fill("#box", "")
    page_paste(pg, "#box", "Marcus Bell at marcus.bell@riversidedental.com")
    val = pg.input_value("#box")
    check("locked: built-in detectors still scrub the paste", val.endswith(" at [EMAIL_1]"), val)
    check("locked: custom terms not applied, and the toast says so",
          val.startswith("Marcus Bell") and "custom terms locked" in shadow_text(pg), [val, shadow_text(pg)])

    pop.bring_to_front(); pop.click("#lockBanner")
    pop.fill("#unlockPw", "wrong password!"); pop.click("#unlockGo"); pop.wait_for_timeout(2500)
    check("unlock: wrong password fails cleanly and stays locked",
          pop.inner_text("#unlockMsg") == "Wrong password." and "listKey" not in session(), pop.inner_text("#unlockMsg"))
    pop.fill("#unlockPw", PW); pop.click("#unlockGo")
    pop.wait_for_function("() => !document.getElementById('listsBox').hidden", timeout=10000)
    check("unlock: right password unlocks and shows the lists",
          pop.input_value("#terms") == "Marcus Bell\nRiverside Dental" and pop.is_hidden("#lockBanner"), pop.input_value("#terms"))
    pg.fill("#box", ""); page_paste(pg, "#box", "Marcus Bell at marcus.bell@riversidedental.com")
    check("unlocked: custom terms apply again", pg.input_value("#box") == "[TERM_2] at [EMAIL_1]", pg.input_value("#box"))

    opt.reload(); status_is(opt, "On · unlocked")
    opt.fill("#newPw", PW2); opt.fill("#newPw2", PW2); opt.click("#setGo")
    opt.wait_for_function("() => document.getElementById('lockMsg').textContent.includes('re-encrypted')", timeout=10000)
    salt_changed = lists()["kdf"]["salt"] != l["kdf"]["salt"]
    opt.click("#lockNow"); status_is(opt, "On · locked")
    opt.fill("#unlockPw", PW); opt.click("#unlockForm button"); opt.wait_for_timeout(2500)
    old_refused = opt.inner_text("#lockMsg") == "Wrong password."
    opt.fill("#unlockPw", PW2); opt.click("#unlockForm button"); status_is(opt, "On · unlocked")
    check("change password: re-encrypted with a new salt; old password refused, new one works", salt_changed and old_refused)

    with opt.expect_download() as dl:
        opt.fill("#expPw", "backup pass 1"); opt.fill("#expPw2", "backup pass 1"); opt.click("#exportForm button")
    backup = Path(dl.value.path()).read_text()
    check("backup: encrypted file downloaded", json.loads(backup)["format"] == "promptveil-lists-backup" and "Marcus" not in backup)
    sw.evaluate("saveLists({terms: ['changed'], allow: []})")
    opt.set_input_files("#impFile", dl.value.path()); opt.fill("#impPw", "not the password"); opt.click("#importForm button")
    opt.wait_for_function("() => document.getElementById('backupMsg').textContent.startsWith('Wrong')", timeout=10000)
    check("backup: wrong password fails cleanly", opt.inner_text("#backupMsg") == "Wrong password.", opt.inner_text("#backupMsg"))
    opt.fill("#impPw", "backup pass 1"); opt.click("#importForm button")
    opt.wait_for_function("() => document.getElementById('backupMsg').textContent.startsWith('Imported')", timeout=10000)
    got = sw.evaluate("listState()")["lists"]
    check("backup: import restores the lists", got["terms"] == ["Marcus Bell", "Riverside Dental"], got)

    opt.click("#removePw"); status_is(opt, "Off")
    check("remove password: back to the device key, session key dropped, lists intact",
          lists()["mode"] == "device" and "listKey" not in session() and sw.evaluate("listState()")["lists"]["terms"] == ["Marcus Bell", "Riverside Dental"])

    opt.fill("#newPw", PW); opt.fill("#newPw2", PW); opt.click("#setGo"); status_is(opt, "On · unlocked")
    opt.click("#lockNow"); status_is(opt, "On · locked")
    opt.click("#resetLists"); status_is(opt, "Off")
    check("forgot password: lists deleted, lock off", "lists" not in sw.evaluate("chrome.storage.local.get(null)")
          and sw.evaluate("listState()")["lists"] == {"terms": [], "allow": []})
    opt.screenshot(path=str(SHOTS / "ext_options.png"), full_page=True)
    sw.evaluate("saveLists({terms: ['Marcus Bell', 'Riverside Dental'], allow: []})")

    # Last, because it empties the vault: starting a new session removes the buttons.
    pop.click("nav button[data-tab=vault]"); pop.click("#reset"); pa.wait_for_timeout(1500)
    check("button: removed when the vault is reset", pa.locator("promptveil-copy").count() == 0,
          pa.locator("promptveil-copy").count())

    ctx.close()

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
