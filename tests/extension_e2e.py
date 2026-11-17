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

def page_paste(pg, selector, text):
    """Paste like a user does: put the text on the clipboard, then press Ctrl+V in the field."""
    pg.bring_to_front()
    pg.evaluate("t => navigator.clipboard.writeText(t)", text)
    pg.focus(selector); pg.keyboard.press("Control+V")
    pg.wait_for_timeout(400)

def synthetic_paste(pg, selector, text):
    """A paste event made up by the page's own script (isTrusted false). PromptVeil must ignore it."""
    pg.evaluate("""([sel, text]) => { const dt = new DataTransfer(); dt.setData('text/plain', text);
        document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }""",
        [selector, text])
    pg.wait_for_timeout(400)

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))
    if not cond: failures.append(name)

with sync_playwright() as p, tempfile.TemporaryDirectory() as prof:
    ctx = p.chromium.launch_persistent_context(prof, executable_path=CHROME, headless=False,
        args=["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        viewport={"width": 1100, "height": 700})
    ctx.route("https://chatgpt.com/**", lambda r: r.fulfill(body=TEXTAREA_PAGE, content_type="text/html"))
    ctx.route("https://claude.ai/**", lambda r: r.fulfill(body=RICH_PAGE, content_type="text/html"))
    ctx.route("https://example.com/**", lambda r: r.fulfill(body=TEXTAREA_PAGE, content_type="text/html"))
    for origin in ["https://chatgpt.com", "https://claude.ai", "https://example.com"]:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin)
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

    # 3b. The page can't use its own (synthetic) paste events to probe the vault for known values:
    # known values reuse their placeholder, so the returned placeholder would reveal what's in it.
    vault_before = sw.evaluate("chrome.storage.session.get('mapping')")["mapping"]
    pg2.evaluate("() => { document.getElementById('ed').textContent = ''; window.seen = []; }")
    probe = "is marcus.bell@riversidedental.com known? and new.person@example.org"
    synthetic_paste(pg2, "#ed", probe)
    # PromptVeil must not touch the page's own event: the vault is unchanged, and the page's paste
    # handler gets back exactly what it sent, with no placeholder in it.
    check("synthetic paste events from the page are ignored (no vault probing)",
          sw.evaluate("chrome.storage.session.get('mapping')")["mapping"] == vault_before
          and pg2.evaluate("window.seen") == [probe] and "[EMAIL_" not in pg2.inner_text("#ed"),
          [pg2.inner_text("#ed"), pg2.evaluate("window.seen")])

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
    check("non-AI site untouched (paste goes through as is)", pg3.input_value("#box") == "bob@x.io", pg3.input_value("#box"))

    # 6. per-site off switch
    sw.evaluate("chrome.storage.local.set({disabledSites: ['chatgpt.com']})"); pg.wait_for_timeout(200)
    pg.fill("#box", "")
    page_paste(pg, "#box", "raw@x.io")
    check("disabled site: content script stands down (paste goes through as is)", pg.input_value("#box") == "raw@x.io", pg.input_value("#box"))
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

    ctx.close()

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
