/* PromptVeil settings page: password lock and encrypted backup of the word lists.
 * All crypto happens in the service worker; this page only sends passwords to it and never
 * stores them. Messages shown here never include list entries. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const send = msg => chrome.runtime.sendMessage(msg).then(r => { if (r && r.error) throw new Error(r.error); return r; });
  const say = (el, text, bad) => { el.textContent = text; el.classList.toggle("bad", !!bad); };

  async function draw() {
    const st = await send({ type: "lists.get" });
    const on = st.mode === "password";
    $("lockStatus").textContent = !on ? "Off" : st.locked ? "On · locked" : "On · unlocked";
    $("lockExplain").textContent = on
      ? "Your lists are encrypted with a key made from your password. The key is kept in memory only while unlocked, and is " +
        "forgotten when you lock, after the idle timeout, or when the browser closes. While locked, pastes on the AI sites " +
        "are blocked, so nothing goes through without your custom terms."
      : "Your lists are encrypted with a random key stored in this browser profile. That stops casual reading of the " +
        "profile files, not someone with full access to this computer. Add a password for stronger protection.";
    $("setForm").hidden = on && st.locked;
    $("newPwLabel").textContent = on ? "Change password: new password (at least 8 characters)" : "New password (at least 8 characters)";
    $("setGo").textContent = on ? "Change password" : "Turn on password lock";
    $("unlockForm").hidden = !(on && st.locked);
    $("lockedActions").hidden = !(on && !st.locked);
    $("resetLists").textContent = on ? "Forgot password? Delete my lists" : "Delete my lists";
    $("exportForm").querySelector("button").disabled = !!(st.locked || st.broken);
    $("importForm").querySelector("button").disabled = !!st.locked;
    return st;
  }

  function clear(...ids) { for (const id of ids) $(id).value = ""; }

  $("setForm").addEventListener("submit", async e => {
    e.preventDefault();
    if ($("newPw").value !== $("newPw2").value) return say($("lockMsg"), "The passwords don't match.", true);
    say($("lockMsg"), "Encrypting…");
    try {
      await send({ type: "lock.set", password: $("newPw").value });
      say($("lockMsg"), "Password lock is on. Your lists were re-encrypted.");
    } catch (err) {
      say($("lockMsg"), err.message === "locked" ? "Unlock first." : err.message, true);
    }
    clear("newPw", "newPw2");
    draw();
  });

  $("unlockForm").addEventListener("submit", async e => {
    e.preventDefault();
    say($("lockMsg"), "Unlocking…");
    try {
      await send({ type: "lock.unlock", password: $("unlockPw").value });
      say($("lockMsg"), "Unlocked.");
    } catch (_) {
      say($("lockMsg"), "Wrong password.", true);
    }
    clear("unlockPw");
    draw();
  });

  $("lockNow").addEventListener("click", async () => {
    await send({ type: "lock.lock" });
    say($("lockMsg"), "Locked.");
    draw();
  });

  $("removePw").addEventListener("click", async () => {
    if (!confirm("Remove the password? Your lists stay encrypted, with a key stored in this browser profile instead.")) return;
    try {
      await send({ type: "lock.remove" });
      say($("lockMsg"), "Password removed. Your lists were re-encrypted with this browser's key.");
    } catch (_) {
      say($("lockMsg"), "Unlock first.", true);
    }
    draw();
  });

  $("resetLists").addEventListener("click", async () => {
    if (!confirm("Delete your \"Always hide\" and \"Never hide\" lists and turn the password off? This can't be undone.")) return;
    await send({ type: "lists.reset" });
    say($("lockMsg"), "Lists deleted. Password lock is off.");
    draw();
  });

  $("exportForm").addEventListener("submit", async e => {
    e.preventDefault();
    if ($("expPw").value !== $("expPw2").value) return say($("backupMsg"), "The passwords don't match.", true);
    say($("backupMsg"), "Encrypting…");
    try {
      const { data } = await send({ type: "lists.export", password: $("expPw").value });
      const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `promptveil-lists-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      say($("backupMsg"), "Backup downloaded. Keep the password somewhere safe: without it the file can't be opened.");
    } catch (err) {
      say($("backupMsg"), err.message === "locked" ? "Unlock first." : err.message, true);
    }
    clear("expPw", "expPw2");
  });

  $("importForm").addEventListener("submit", async e => {
    e.preventDefault();
    const file = $("impFile").files[0];
    if (!file) return say($("backupMsg"), "Choose a backup file.", true);
    if (file.size > 1000000) return say($("backupMsg"), "That file is too large to be a PromptVeil backup.", true);
    say($("backupMsg"), "Decrypting…");
    try {
      const r = await send({ type: "lists.import", data: await file.text(), password: $("impPw").value });
      say($("backupMsg"), `Imported ${r.terms} "Always hide" and ${r.allow} "Never hide" entries.`);
    } catch (err) {
      say($("backupMsg"), err.message === "wrong password" ? "Wrong password." : err.message === "locked" ? "Unlock first." : "That isn't a PromptVeil backup.", true);
    }
    clear("impPw");
    draw();
  });

  chrome.storage.local.get({ idleMinutes: 60 }).then(s => { $("idleMinutes").value = String(s.idleMinutes); });
  $("idleMinutes").addEventListener("change", async () => {
    await chrome.storage.local.set({ idleMinutes: Number($("idleMinutes").value) });
    say($("idleMsg"), "Saved.");
  });

  // Clipboard auto-clear needs the optional clipboardRead permission (asked for here, during the
  // click, because Chrome only shows the prompt for a user gesture). Declined: it stays off.
  const radios = [...document.querySelectorAll('input[name="clip"]')];
  const setRadio = v => radios.forEach(r => { r.checked = Number(r.value) === v; });
  (async () => {
    const { clipboardClearSeconds: secs } = await chrome.storage.local.get({ clipboardClearSeconds: 0 });
    const granted = await chrome.permissions.contains({ permissions: ["clipboardRead"] });
    setRadio(secs && granted ? secs : 0);
    if (secs && !granted) await chrome.storage.local.set({ clipboardClearSeconds: 0 }); // permission was removed elsewhere
  })();
  for (const r of radios) {
    r.addEventListener("change", async () => {
      const secs = Number(r.value);
      if (!secs) {
        await chrome.storage.local.set({ clipboardClearSeconds: 0 });
        await chrome.permissions.remove({ permissions: ["clipboardRead"] }).catch(() => {});
        return say($("clipMsg"), "Off. PromptVeil no longer has permission to read the clipboard.");
      }
      let granted = false;
      try { granted = await chrome.permissions.request({ permissions: ["clipboardRead"] }); } catch (_) { granted = false; }
      if (!granted) {
        setRadio(0);
        await chrome.storage.local.set({ clipboardClearSeconds: 0 });
        return say($("clipMsg"), "Auto-clear stays off. It needs permission to read the clipboard, to check it still holds " +
          "what PromptVeil copied before clearing it. Without that check it could wipe something you copied later.", true);
      }
      await chrome.storage.local.set({ clipboardClearSeconds: secs });
      say($("clipMsg"), "On. Copies with real values are cleared from the clipboard if nothing else was copied since.");
    });
  }

  draw();
})();
