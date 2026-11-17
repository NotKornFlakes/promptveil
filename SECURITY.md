# Security

PromptVeil is a safety net for pasting text into AI chat sites: it swaps sensitive values for placeholders on your
device and puts them back afterwards. This page says what it protects against, what it doesn't, how the data it
keeps is protected, and how to report a vulnerability.

## Threat model

**PromptVeil protects against:**

- **The AI site (and whoever runs it) seeing the real values you paste.** Pastes into the supported chat boxes
  are scrubbed before the page's own code receives them. If scrubbing fails, the paste is blocked.
- **The AI site's page reading restored values.** Real values are put back only in extension contexts (the
  service worker, a hidden offscreen page that writes the clipboard, and PromptVeil's own pages), never in the
  site's page. The page can't call the extension's messaging API, and PromptVeil's content script only ever gets
  back counts and yes/no answers.
- **Casual reading of your browser profile on disk** (backups, synced folders, someone browsing your files).
  The word lists are encrypted; the placeholder vault is never written to disk.
- **With "Lock with a password": someone with a copy of your profile files** reading your word lists, unless they
  can guess the password. PBKDF2 slows guessing down; a weak password can still be cracked offline.
- **Shoulder-surfing and screen sharing.** Real values are masked or blurred in PromptVeil's pages until you
  choose to show them, and hide again after 30 seconds.
- **Data left lying around.** The vault is cleared after an idle timeout and when the browser closes; with a
  password set, the lists lock on idle or when the computer locks; the clipboard can be cleared after a copy.

**PromptVeil does not protect against:**

- **Malware, or anyone using your unlocked computer or browser profile.** In the default mode the key that
  encrypts your lists sits in the same profile as the lists. Other extensions with broad permissions, a
  compromised browser, or a malicious PromptVeil update are out of scope too. Keys and values held in memory can
  end up in swap or crash dumps.
- **What the AI site sees anyway:** the placeholders, the text around them, how many items of each type were
  hidden, and text you type (the site can read the chat box as you type; the optional typed-text check only stops
  it from being sent).
- **Detection gaps.** PromptVeil is pattern matching. It won't spot names, addresses or company names unless they
  are in your "Always hide" list, or secrets in formats it doesn't know. Context can still identify someone.
- **Other apps reading the clipboard.** Restored text you copy is readable by anything that can read the
  clipboard, and clipboard-history tools keep their own copy even after PromptVeil clears it.
- **Text you drag and drop** into the chat box. Only pastes are scrubbed automatically.

**Known limits of the design:**

- A site can tell PromptVeil is installed (its button and toast elements are visible in the page, even though
  their contents are in closed shadow roots).
- A site can find out which placeholder *names* exist in the vault (for example that `EMAIL_5` exists), by
  showing text and seeing whether a "Copy with real values" button appears. The vault is shared between the AI
  sites, so this can reveal how many items of a type you hid elsewhere. It never reveals a value.
- The content script on the AI sites can read `chrome.storage.local`, which holds the encrypted lists. It can't
  read the device key (IndexedDB of the extension's own origin) or the password-derived key
  (`chrome.storage.session`, restricted to trusted contexts).
- Earlier versions stored the lists as plain text. They are encrypted on update and the plain copy is deleted,
  but Chrome's storage files may keep old copies on disk until it compacts them.

## How data is stored

### Browser extension

| What | Where | Protection |
|---|---|---|
| Placeholder vault (placeholder → real value) | `chrome.storage.session` | Memory only, never on disk. Cleared after the idle timeout (default 60 min), with **New session**, and when the browser closes. Readable only by trusted extension contexts (`setAccessLevel(TRUSTED_CONTEXTS)` is set at startup). |
| "Always hide" / "Never hide" lists | `chrome.storage.local` (profile folder) | One AES-256-GCM blob, fresh random 12-byte IV on every save. The additional authenticated data binds the format version and mode. |
| Device key (default mode) | IndexedDB of the extension's origin | Random AES-256-GCM key, generated on first use, non-extractable (scripts can use it but can't read its bytes). On disk in the same profile, so this only stops casual reading. |
| Password-derived key (password mode) | `chrome.storage.session` while unlocked | PBKDF2-SHA256, 600,000 iterations, random 16-byte salt (stored next to the ciphertext). The password itself is never stored. The key is dropped on lock, after the idle timeout, when the computer locks or goes idle, and when the browser closes. It is only written after session storage has been restricted to trusted contexts. |
| Backup file (export) | Wherever you save it | AES-256-GCM with a key from your backup password (PBKDF2-SHA256, 600,000 iterations, its own 16-byte salt). |
| Clipboard auto-clear state | `chrome.storage.session` | A SHA-256 of the text PromptVeil copied, used to check the clipboard still holds it before clearing. Off by default; needs the optional `clipboardRead` permission, requested only when you turn it on. |
| Settings (per-site on/off, typed-text check, timeouts) | `chrome.storage.local` | Plain text. They contain no personal data. |

There is no password recovery. Forgetting the password means deleting the lists and starting over.

Why the password-derived key lives in `chrome.storage.session` rather than only in the service worker's memory:
Chrome stops an idle extension service worker after about 30 seconds, which would lock PromptVeil every time you
paused. Session storage is also memory only, and is closed to content scripts.

### Command-line tool

| What | Where | Protection |
|---|---|---|
| Placeholder vault | `~/.local/share/promptveil/vault.json` (`0600`) | With `pip install 'promptveil[secure]'`: AES-256-GCM with a fresh random 12-byte nonce on every write. The header (format version, creation time, expiry, key type) is bound in as additional authenticated data, so changing the expiry breaks decryption. Without the extra: plain text, with a one-time note saying so. |
| Vault key, keyring mode (default with the extra) | Your OS keyring, through `secret-tool` (libsecret) | A random 32-byte key, created on first use. It is passed to and from `secret-tool` over stdin/stdout, never on the command line. |
| Vault key, password mode | Not stored | Derived from your password with scrypt (n=2^17, r=8, p=1) and a fresh random 16-byte salt on every write. `--password` asks on the terminal (twice for a new vault); `PROMPTVEIL_PASSWORD` is the non-interactive option. |
| Expiry | In the vault file | Every `scrub` sets an expiry: `--ttl`, or `ttl` under `[vault]` in `~/.config/promptveil/config.ini`, else 24 hours. An expired vault is deleted the next time `promptveil` runs. |
| Word lists | `~/.config/promptveil/terms.txt`, `allow.txt` | Plain-text files you manage yourself. |

With the extra installed but no keyring and no password, `promptveil scrub` stops with an error and prints nothing,
rather than writing the vault in plain text or handing out text that could never be restored.

- `PROMPTVEIL_PASSWORD` can be read by other processes running as you (`/proc/<pid>/environ`) and ends up in
  shell history if you type it inline. Prefer `--password` when you're at a terminal.
- `promptveil forget` and expiry delete the file normally. On SSDs and journaling file systems the old bytes can
  stay on disk until they're overwritten, which is one more reason to use the encrypted mode.
- `promptveil show` masks values unless you pass `--reveal`.

## Trust boundaries in the extension

- **AI site page:** untrusted. It can't reach the extension's messaging API. Paste events it dispatches itself are
  ignored, so it can't use the scrubber to test guesses against the vault.
- **Content script** (isolated world on the 8 AI sites): may send only `scrub`, `has` (yes/no), `scan` (counts,
  only when the typed-text check is on) and `copyRestored` (count only, sent only after a trusted click on
  PromptVeil's own button). The service worker checks that these come from a tab on one of the AI sites.
  Text is capped at 1,000,000 characters.
- **Service worker:** owns the vault, the lists and the keys. Everything that returns real values or changes
  keys is refused unless the sender is one of PromptVeil's own pages.
- **Offscreen document:** writes and clears the clipboard; accepts messages only from the service worker.
- **Other extensions and websites:** `externally_connectable` allows no one, and there are no
  `web_accessible_resources`, so sites can't load PromptVeil's pages.
- **Extension pages:** CSP `script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'`. The extension's code makes no network requests. The content
  script runs inside the AI site's page under that site's own policy and contains no networking code.
- PromptVeil writes text into pages only with `textContent` and DOM calls, never `innerHTML`, and never puts a
  real value in a toast, the toolbar badge, a page title, the console or an error message.

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. Please don't open a public issue for a vulnerability.

Include what you found, the steps to reproduce it, and which part is affected (extension, web page or CLI, and the
version). This is a small open-source project: reports are handled on a best-effort basis, and there is no bug
bounty. Fixed issues are credited in the release notes unless you'd rather stay anonymous.
