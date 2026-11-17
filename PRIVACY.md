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
  (`chrome.storage.session`). It is never written to disk and is erased when you close the browser or click
  **New session**.
- When you click **Copy with real values**, use the right-click menu or press the keyboard shortcut, the real values
  are put back inside the extension and the result is written to your **clipboard**. They are never put into the
  AI site's page. Like anything you copy, other apps on your computer can read the clipboard until you copy
  something else.
- Your "Always hide" and "Never hide" lists are stored **on disk, unencrypted**, in `chrome.storage.local`
  (your browser profile folder on this device), together with your per-site on/off settings and the typed-text
  setting. Anyone who can read your browser profile can read these lists.

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
| `clipboardWrite` | To copy restored text when you click **Copy with real values**, use the right-click menu or press the shortcut. PromptVeil never reads your clipboard. |

The keyboard shortcut (Ctrl+Shift+Y, Cmd+Shift+Y on Mac) is a `commands` entry in the manifest, not a permission.
You can change or remove it at `chrome://extensions/shortcuts`.

## Contact

Questions: open an issue at the project's GitHub repository.
