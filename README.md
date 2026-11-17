# PromptVeil

**Redact before you prompt. Restore after it answers.**

People paste customer emails, server logs, API keys and contracts into ChatGPT and Claude every day.
PromptVeil swaps the sensitive parts for consistent placeholders *before* the text leaves your machine,
then puts the real values back into the AI's answer, all locally.

```
Customer jane.doe@acme.com on 10.0.4.12 can't log in, key AKIAIOSFODNN7EXAMPLE
            ↓ promptveil scrub
Customer [EMAIL_1] on [IP_1] can't log in, key [AWS_KEY_1]
            ↓ (ask the AI)
Disable [AWS_KEY_1], then check auth logs on IP_1 for [EMAIL_1].
            ↓ promptveil restore
Disable AKIAIOSFODNN7EXAMPLE, then check auth logs on 10.0.4.12 for jane.doe@acme.com.
```

Because the same value always gets the same placeholder, the AI can still reason about *who did what to which
server*. It just never sees the real data.

## Browser extension (Chrome, Brave, Edge)

Paste into ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral or Grok as usual. PromptVeil
scrubs the text **before the site ever sees it** and shows a small "Hid 7 items" notice. When the answer
comes back, click **Copy with real values** under it. PromptVeil puts the real values back and copies the
result to your clipboard, ready to paste wherever you need it.

Other ways to get the real values back:

- Select text, then right-click → **Restore real values with PromptVeil**, or press **Ctrl+Shift+Y**
  (**Cmd+Shift+Y** on Mac). Both copy straight to the clipboard and show a short notice.
- Right-click → **Restore and view…** opens a window that shows the restored text before you copy it.

Optional: turn on **Check typed text before sending** in Settings (off by default). If you press Enter or
Send with something sensitive in the chat box, the message is stopped once and a **Hide N items** button
swaps the sensitive parts for placeholders. The site can still see what you type as you type it.

How it stays private:

- Real values are restored only inside the extension (its service worker, a hidden offscreen page that writes
  the clipboard, and its own windows), never in the AI site's page, so the site can't read them. The page
  script only ever learns whether an answer contains placeholders PromptVeil knows, and how many it restored.
- The vault lives in `chrome.storage.session` (memory only, erased when the browser closes).
- If scrubbing ever fails, the paste is **blocked**, not let through.
- The extension's code makes no network requests. Its CSP (`connect-src 'none'`) enforces that for the
  extension's own pages and service worker. The content script runs inside the AI site's page and follows
  that site's own rules.
- The **Copy with real values** button finds answers with per-site selectors (`SITES` in
  `extension/content.js`). If a site changes its markup, the button stops appearing there until the selectors
  are updated; right-click and the shortcut keep working.

**Try it now:** `brave://extensions` → Developer mode → **Load unpacked** → pick the `extension/` folder.
A welcome page with a try-it box opens on install.
**Publish it:** see [STORE_LISTING.md](STORE_LISTING.md). Privacy policy: [PRIVACY.md](PRIVACY.md).

```bash
python3 scripts/build_extension.py   # syncs engine.js from web/index.html, writes dist/*.zip
# 65 checks in real Chrome (needs playwright). Branded Chrome 137+ ignores --load-extension,
# so point CHROME at Chrome for Testing (e.g. the one `playwright install chromium` downloads).
CHROME=/path/to/chrome-for-testing python3 tests/extension_e2e.py
```

## Two more ways to use it

| | Web page (`web/index.html`) | CLI (`promptveil`) |
|---|---|---|
| Where it runs | In your browser, single static file | Your terminal, Python 3.10+, zero dependencies |
| Network | None. A strict CSP blocks every request | None |
| Mapping stored | In memory only; closing the tab erases it | `~/.local/share/promptveil/vault.json` (0600) |
| Best for | Quick copy/paste, sharing with non-technical people | Pipelines, clipboard workflows, pre-commit / CI scanning |

### Web page
Open `web/index.html` or host it as a static page (GitHub Pages, Cloudflare Pages, your portfolio site).
It's one self-contained file with no build step.

### CLI

```bash
pip install .            # or: pipx install .

# Fedora / Wayland clipboard workflow
wl-paste | promptveil scrub | wl-copy        # paste into the AI
wl-paste | promptveil restore | wl-copy      # paste the AI's answer back in, get the real one

# Files and pipes
promptveil scrub incident.md > safe.md
promptveil scrub -t "Acme Corp" -t "Project Falcon" notes.txt
promptveil restore answer.txt

# Report only: exits 1 if anything is found (CI, pre-commit, "is this safe to paste?")
promptveil scan prompts/*.md CLAUDE.md

promptveil show            # list placeholders (masked; --reveal to show values)
promptveil forget          # delete the vault
```

On X11, use `xclip -o -sel clip` / `xclip -sel clip` instead of `wl-paste` / `wl-copy`.

**Your own word lists**: `~/.config/promptveil/terms.txt` (always hide: client names, codenames, hostnames)
and `~/.config/promptveil/allow.txt` (never hide). One entry per line, `#` for comments.

### pre-commit hook

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/<you>/promptveil
    rev: v0.1.0
    hooks:
      - id: promptveil-scan
```

## What it detects

| Category | Placeholders |
|---|---|
| Secrets | `PRIVATE_KEY`, `AWS_KEY`, `GITHUB_TOKEN`, `API_KEY` (OpenAI/Anthropic), `SLACK_TOKEN`, `GOOGLE_KEY`, `STRIPE_KEY`, `JWT`, `PASSWORD` (in connection URLs), `SECRET` (`password=…`, `api_key: …`, `token=…`) |
| Personal data | `EMAIL`, `PHONE`, `CARD` (Luhn-validated), `SSN` (rejects invalid ranges) |
| Network | `IP`, `IPV6`, `MAC`, `HOST` (`*.internal`, `.local`, `.lan`, `.corp`, `.intranet`, `.home.arpa`) |
| Yours | `TERM` (anything in your terms list) |

Overlaps are resolved by priority (secrets > your terms > PII > network), so nothing gets double-redacted.

## Limits (read this)

PromptVeil is a **safety net, not a guarantee**. It's pattern matching:

- It won't spot people's names, company names or addresses unless you add them to your terms list.
- Context can still identify someone ("the CEO of our Ohio branch"). Rewrite those yourself.
- The CLI vault stores real values in plain text on your disk (0600). Run `promptveil forget` when you're done.

Review the scrubbed text before you send it.

## Development

```bash
pip install -e . pytest
pytest                                # Python engine + CLI
node --test tests/web_engine.test.mjs # JS engine, incl. byte-for-byte parity with Python
```

The detection rules live in two places, `src/promptveil/detectors.py` and the `<script id="engine">` block in
`web/index.html`. The parity test fails if they drift apart.

## Roadmap

- [ ] Browser extension: scrub automatically on chatgpt.com / claude.ai, restore in-page
- [ ] Optional on-device name detection (small NER model)
- [ ] Team rules file (shared terms/allow lists, enforced in CI)
- [ ] Encrypted vault (`age`)

## License

MIT
