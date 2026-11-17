# PromptVeil Privacy Policy

_Last updated: November 16, 2026_

PromptVeil is built so that it never collects your data. This applies to the browser extension, the web page
and the command-line tool.

## What PromptVeil does with your text

- When you paste text into a supported AI chat site, PromptVeil scans it **on your device** and replaces sensitive
  values (emails, phone numbers, keys, passwords, card numbers, IP addresses, and terms you choose) with placeholders.
- **Typed text** is checked only if you turn on **Check typed text before sending** (off by default). When it's
  on, the text in the chat box is checked on your device as you type, and a message with sensitive items is
  stopped once when you press Enter or Send. The site can still see what you type as you type it; the check only
  stops it from being sent.
- The mapping between placeholders and real values (the "vault") is kept in the browser's **session memory**
  (`chrome.storage.session`). It is never written to disk. It is erased when you close the browser, when you click
  **New session**, and when you haven't used PromptVeil for a while (60 minutes by default; you can choose 15, 30,
  60 or 240 minutes, or never).
- When you click **Copy with real values**, use the right-click menu or press the keyboard shortcut, the real values
  are put back inside the extension and the result is written to your **clipboard**. They are never put into the
  AI site's page. Like anything you copy, other apps on your computer can read the clipboard until you copy
  something else. If you turn on **Clear the clipboard** (off by default), PromptVeil clears it 30 seconds to
  2 minutes later, but only if it still holds what PromptVeil copied. To check that, it reads the clipboard once,
  compares a hash in memory, and keeps or sends nothing.
- Your "Always hide" and "Never hide" lists are stored in `chrome.storage.local` (your browser profile folder on
  this device), **encrypted** with AES-256-GCM:
  - By default, the key is a random key created on your device and kept in the extension's IndexedDB storage in
    the same profile, marked so that scripts can use it but not read it out. This keeps the lists from being read
    in plain text by anyone browsing your profile files. It does not protect them from someone or something with
    full access to your computer, because the key is stored next to them.
  - If you turn on **Lock with a password**, the key is derived from your password (PBKDF2-SHA256, 600,000
    iterations, random salt) and kept only in memory while PromptVeil is unlocked. Your password is never stored.
    PromptVeil locks when you choose, after the idle time, when your computer locks or goes idle, and when the
    browser closes. While locked, pastes are still scrubbed with the built-in rules. There is no password
    recovery.
  - A backup you export is encrypted with the backup password you choose.
  - Earlier versions stored these lists in plain text. Updating encrypts them and deletes the plain copy, although
    Chrome may keep old fragments in its storage files until it compacts them.
- Your other settings (per-site on/off, typed-text check, timeouts) are stored in `chrome.storage.local` without
  encryption. They contain no personal data.
- The **command-line tool** keeps its vault in `~/.local/share/promptveil/vault.json` (readable only by you). With
  the optional `promptveil[secure]` install it is encrypted with AES-256-GCM, with the key in your system keyring
  or derived from your password. Without it, the file is plain text. The vault is deleted 24 hours after your last
  scrub by default. Your CLI word lists are plain-text files you manage.

The [security page](SECURITY.md) has the full threat model and encryption details.

## What PromptVeil does not do

- It does not send any data to the developer or to any third party. The extension's code makes **no network
  requests**. Its content security policy (`connect-src 'none'`) blocks them on the extension's own pages and
  service worker; the content script runs inside the AI site's page, under that site's own rules, and contains no
  networking code.
- It has no analytics, tracking, advertising or remote code.
- It does not sell or transfer user data, does not use it for purposes unrelated to its single purpose,
  and does not use it to determine creditworthiness or for lending.

## Permissions

| Permission | Why |
|---|---|
| Access to chatgpt.com, claude.ai, gemini.google.com, copilot.microsoft.com, perplexity.ai, chat.deepseek.com, chat.mistral.ai, grok.com | To scrub text you paste into those chat boxes. PromptVeil runs on no other sites. |
| `storage` | To keep your settings (on device) and the session vault (in memory). |
| `contextMenus` | For the right-click "Restore real values with PromptVeil" and "Restore and view…" menu items. |
| `scripting` | To read the text you selected (with line breaks) when you use those menu items or the keyboard shortcut. |
| `offscreen` | To open a hidden PromptVeil page that writes restored text to the clipboard. The extension's background service worker can't use the clipboard itself, and restored text must never go through the AI site's page. The hidden page closes after each copy. |
| `clipboardWrite` | To copy restored text when you click **Copy with real values**, use the right-click menu or press the shortcut. |
| `alarms` | To clear the vault and lock after your idle time, and to clear the clipboard after a copy if you turned that on. |
| `idle` | To lock PromptVeil when your computer locks or goes idle, if you set a password. |
| `clipboardRead` (optional) | Not granted at install. Requested only if you turn on **Clear the clipboard**, and given back when you turn it off. Used only to check that the clipboard still holds what PromptVeil copied before clearing it. |

The keyboard shortcut (Ctrl+Shift+Y, Cmd+Shift+Y on Mac) is a `commands` entry in the manifest, not a permission.
You can change or remove it at `chrome://extensions/shortcuts`.

## Contact

Questions: open an issue at the project's GitHub repository.
