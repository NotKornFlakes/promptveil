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
scrubs the text **before the site ever sees it** and shows a small "Hid 7 items" notice. To get the real
values back, select the AI's answer, right-click → **Restore real values with PromptVeil**, then copy.

- Real values are restored only inside the extension's own window, never in the AI site's page, so the site can't read them.
- The vault lives in `chrome.storage.session` (memory only, erased when the browser closes).
- If scrubbing ever fails, the paste is **blocked**, not let through.
- The extension's CSP is `connect-src 'none'`, so it cannot make network requests.

**Try it now:** `brave://extensions` → Developer mode → **Load unpacked** → pick the `extension/` folder.
**Publish it:** see [STORE_LISTING.md](STORE_LISTING.md). Privacy policy: [PRIVACY.md](PRIVACY.md).

```bash
python3 scripts/build_extension.py   # syncs engine.js from web/index.html, writes dist/*.zip
python3 tests/extension_e2e.py       # 16 checks in real Chrome (needs playwright)
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
