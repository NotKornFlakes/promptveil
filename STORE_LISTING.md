# Publishing PromptVeil to the Chrome Web Store

A Chrome Web Store listing works in Chrome, Brave, Edge, Opera, Vivaldi and Arc.

## 1. One-time setup (about 15 minutes)

1. Go to <https://chrome.google.com/webstore/devconsole> and sign in with the Google account you want to publish from.
2. Pay the one-time **$5 developer registration fee**.
3. Verify your contact email (Account tab).
4. Host the privacy policy somewhere public, e.g. your site at `/promptveil/privacy`, or link the
   `PRIVACY.md` file on GitHub.

## 2. Build the upload

```bash
python3 scripts/build_extension.py      # -> dist/promptveil-extension-0.1.0.zip
```

## 3. Create the item

Dev console → **New item** → upload the zip, then fill in the fields below.

### Store listing

**Name:** PromptVeil – Redact before you prompt

**Summary (132 chars max):**
Automatically hides emails, keys, passwords, card numbers and IPs when you paste into ChatGPT, Claude or Gemini. 100% local.

**Category:** Productivity (or Developer Tools)

**Description:**

> Every day people paste customer emails, server logs, API keys and contracts into AI chatbots. PromptVeil catches the sensitive parts **before** they leave your browser.
>
> HOW IT WORKS
> • Paste into ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral or Grok as usual.
> • PromptVeil swaps sensitive values for placeholders like [EMAIL_1], [IP_1] or [AWS_KEY_1]. The same value always gets the same placeholder, so the AI can still follow along.
> • When the answer comes back, click "Copy with real values" under it (or select text and press Ctrl+Shift+Y). The finished text, with the real names and numbers back in, goes straight to your clipboard.
>
> WHAT IT HIDES
> Emails, phone numbers, payment cards (Luhn-checked), US SSNs, IPv4/IPv6/MAC addresses, internal hostnames, private keys, AWS / GitHub / OpenAI / Anthropic / Slack / Google / Stripe keys, JWTs, passwords in configs and connection strings, and any names or codenames you add to your "Always hide" list.
>
> PRIVATE BY DESIGN
> • Runs 100% on your device. No servers, no accounts, no analytics.
> • The extension's code makes no network requests, and its security policy blocks them on its own pages.
> • Real values are kept in memory only and erased when you close the browser.
> • Real values are never put back into the AI website's page, so the site can't read them.
> • Open source (MIT).
>
> LIMITS
> PromptVeil is pattern-based. It won't recognize people's names unless you add them. It scrubs pasted text automatically; typed text is only checked if you turn on "Check typed text before sending". Review before you send.

### Graphics
- Icon: `extension/icons/128.png`
- Screenshots (1280×800): `store/screenshot-1.png`, `store/screenshot-2.png`

### Privacy practices tab
- **Single purpose:** Remove sensitive information from text pasted into AI chat websites, and restore it locally in the AI's response.
- **storage justification:** Saves the user's own word lists and per-site settings on the device, and keeps the placeholder mapping in session memory.
- **contextMenus justification:** Adds "Restore real values" and "Restore and view…" items for selected AI responses.
- **scripting justification:** Reads the user's selected text, with line breaks, when they choose "Restore real values" or press the keyboard shortcut.
- **offscreen justification:** Opens a hidden extension page (reason CLIPBOARD) that writes restored text to the clipboard, because the service worker can't, and restored text must not be put into the AI site's page. It closes after each copy.
- **clipboardWrite justification:** Copies the AI's answer with the user's real values restored when they click "Copy with real values", use the right-click menu or press the shortcut. The extension never reads the clipboard.
- **Host permission justification:** The content script must run on the listed AI chat sites to scrub pasted text. It runs on no other sites.
- **Remote code:** No, I am not using remote code.
- **Data usage:** Check *none* of the data types (nothing is collected). Certify all three disclosures.
- **Privacy policy URL:** your hosted copy of `PRIVACY.md`.

## 4. Submit for review
Reviews usually take from a few days up to about 2 weeks. Narrow host permissions (like these) are reviewed faster than `<all_urls>`.

## Updating
Bump `"version"` in `extension/manifest.json`, rebuild and upload the new zip under **Package**.

## Try it before publishing (Brave / Chrome)
1. Go to `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin PromptVeil from the puzzle-piece menu.
