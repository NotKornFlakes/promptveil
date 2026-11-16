# PromptVeil Privacy Policy

_Last updated: November 15, 2026_

PromptVeil is built so that it never collects your data. This applies to the browser extension, the web page
and the command-line tool.

## What PromptVeil does with your text

- When you paste text into a supported AI chat site, PromptVeil scans it **on your device** and replaces sensitive
  values (emails, phone numbers, keys, passwords, card numbers, IP addresses, and terms you choose) with placeholders.
- The mapping between placeholders and real values (the "vault") is kept in the browser's **session memory**
  (`chrome.storage.session`). It is never written to disk and is erased when you close the browser or click
  **New session**.
- Your "Always hide" and "Never hide" lists and your per-site on/off settings are stored locally
  (`chrome.storage.local`) on your device.

## What PromptVeil does not do

- It does not send any data to the developer or to any third party. The extension makes **no network requests**,
  and its content security policy blocks them (`connect-src 'none'`).
- It has no analytics, tracking, advertising or remote code.
- It does not sell or transfer user data, does not use it for purposes unrelated to its single purpose,
  and does not use it to determine creditworthiness or for lending.

## Permissions

| Permission | Why |
|---|---|
| Access to chatgpt.com, claude.ai, gemini.google.com, copilot.microsoft.com, perplexity.ai, chat.deepseek.com, chat.mistral.ai, grok.com | To scrub text you paste into those chat boxes. PromptVeil runs on no other sites. |
| `storage` | To keep your settings (on device) and the session vault (in memory). |
| `contextMenus` | For the right-click "Restore real values with PromptVeil" menu item. |
| `scripting` | To read the text you selected (with line breaks) when you use that menu item. |

## Contact

Questions: open an issue at the project's GitHub repository.
