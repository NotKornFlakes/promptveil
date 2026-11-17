/* PromptVeil popup. Restoring happens only here (or in the restore window), never in the AI site's page. */
(async () => {
  "use strict";
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const send = msg => chrome.runtime.sendMessage(msg).then(r => { if (r && r.error) throw new Error(r.error); return r; });
  const lines = s => s.split("\n").map(x => x.trim()).filter(Boolean);
  const SUPPORTED = (chrome.runtime.getManifest().host_permissions || []).map(p => new URL(p.replace("/*", "/")).hostname);
  if (params.get("window")) document.body.classList.add("window");
  $("help").addEventListener("click", e => { e.preventDefault(); chrome.tabs.create({ url: "welcome.html" }); window.close(); });
  chrome.commands.getAll().then(cmds => {
    const c = cmds.find(x => x.name === "restore-selection");
    if (c && c.shortcut) $("shortcut").textContent = c.shortcut; else $("shortcut").textContent = "your shortcut (set one at chrome://extensions/shortcuts)";
  }).catch(() => {});

  // ---------------------------------------------------------------- tabs
  function show(name) {
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll("section").forEach(s => s.classList.toggle("on", s.id === "tab-" + name));
    if (name === "vault") drawVault();
  }
  document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));

  // ---------------------------------------------------------------- helpers
  function paint(el, parts) {
    el.textContent = "";
    for (const p of parts) {
      if (!p.text) continue;
      if (p.ph || p.real) { const m = document.createElement("mark"); if (p.real) m.className = "real"; m.textContent = p.text; el.appendChild(m); }
      else el.appendChild(document.createTextNode(p.text));
    }
  }
  const mask = v => { v = v.replace(/\n/g, " "); return v.length <= 4 ? "•".repeat(v.length) : v.slice(0, 2) + "•".repeat(Math.min(v.length - 4, 10)) + v.slice(-2); };

  // Real values are hidden by default. A reveal lasts 30 s after the last interaction, and ends
  // anyway when the popup closes (the page is destroyed).
  const REVEAL_MS = 30000;
  function revealer(onShow, onHide) {
    let timer = 0, shown = false;
    const r = {
      get shown() { return shown; },
      show() { shown = true; onShow(); r.bump(); },
      hide() { clearTimeout(timer); if (!shown) return; shown = false; return onHide(); },
      bump() { if (!shown) return; clearTimeout(timer); timer = setTimeout(() => r.hide(), REVEAL_MS); },
    };
    return r;
  }
  async function copy(text, btn) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch { return; }
    const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => btn.textContent = old, 1200);
  }

  // ---------------------------------------------------------------- site toggle
  const [tab] = params.get("window") ? [] : await chrome.tabs.query({ active: true, currentWindow: true });
  let host = null;
  try { host = tab && tab.url ? new URL(tab.url).hostname : null; } catch {}
  const supported = host && SUPPORTED.includes(host);
  const { disabledSites = [] } = await chrome.storage.local.get({ disabledSites: [] });
  if (params.get("window")) $("siteBox").style.display = "none";
  else if (supported) {
    const on = !disabledSites.includes(host);
    $("siteSwitch").checked = on;
    const label = () => { $("siteTxt").replaceChildren(); const b = document.createElement("b"); b.textContent = host;
      $("siteTxt").append(b, $("siteSwitch").checked ? "Pastes are scrubbed automatically" : "Off: pastes go through unchanged"); };
    label();
    $("siteSwitch").addEventListener("change", async () => {
      const cur = (await chrome.storage.local.get({ disabledSites: [] })).disabledSites.filter(h => h !== host);
      if (!$("siteSwitch").checked) cur.push(host);
      await chrome.storage.local.set({ disabledSites: cur });
      label();
    });
  } else {
    $("siteSwitchWrap").style.display = "none";
    $("siteTxt").textContent = "Not an AI chat site. Use the Scrub tab to clean text for anywhere else.";
  }

  // ---------------------------------------------------------------- restore
  let restored = "";
  async function doRestore() {
    const text = $("restoreIn").value;
    if (!text) { $("restoreOut").textContent = ""; $("restoreMeta").textContent = ""; restored = ""; return; }
    const { mapping } = await send({ type: "vault" });
    const r = new PromptVeil.Veil({ mapping }).restoreParts(text);
    restored = r.parts.map(p => p.text).join("");
    paint($("restoreOut"), r.parts);
    $("restoreMeta").textContent = Object.keys(mapping).length
      ? `${r.count} value${r.count === 1 ? "" : "s"} restored`
      : "Vault is empty. Paste into an AI chat first.";
  }
  $("restoreIn").addEventListener("input", doRestore);
  // Works while blurred. Goes through the service worker so the clipboard can be cleared later.
  $("restoreCopy").addEventListener("click", async e => {
    if (!restored) return;
    const btn = e.currentTarget, old = btn.textContent;
    try { await send({ type: "copyText", text: restored }); } catch (_) { btn.textContent = "Couldn't copy"; setTimeout(() => btn.textContent = old, 1500); return; }
    btn.textContent = "Copied"; setTimeout(() => btn.textContent = old, 1200);
  });
  const restoreReveal = revealer(
    () => { $("restoreOut").classList.remove("veiled"); $("restoreShow").textContent = "Hide"; },
    () => { $("restoreOut").classList.add("veiled"); $("restoreShow").textContent = "Show"; });
  $("restoreShow").addEventListener("click", () => (restoreReveal.shown ? restoreReveal.hide() : restoreReveal.show()));

  // ---------------------------------------------------------------- scrub (manual)
  let scrubbed = "";
  $("scrubGo").addEventListener("click", async () => {
    const r = await send({ type: "scrub", text: $("scrubIn").value });
    scrubbed = r.text;
    const { mapping } = await send({ type: "vault" });
    // Re-render with highlights (placeholders are already consistent with the vault).
    paint($("scrubOut"), r.text.split(/(\[[A-Z_]+_\d+\])/).map(t => ({ text: t, ph: /^\[[A-Z_]+_\d+\]$/.test(t) && t.slice(1, -1) in mapping })));
    $("scrubMeta").textContent = `${r.total} hidden`;
  });
  $("scrubCopy").addEventListener("click", e => copy(scrubbed, e.currentTarget));

  // ---------------------------------------------------------------- vault
  async function drawVault() {
    const { mapping } = await send({ type: "vault" });
    const tb = $("vault").tBodies[0]; tb.textContent = "";
    const entries = Object.entries(mapping);
    if (!entries.length) { const td = tb.insertRow().insertCell(); td.colSpan = 3; td.style.color = "var(--mute)"; td.textContent = "Empty. Nothing has been hidden yet."; return; }
    for (const [ph, v] of entries) {
      const tr = tb.insertRow();
      tr.insertCell().textContent = ph;
      const cell = tr.insertCell();
      cell.textContent = mask(v);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "eye";
      btn.textContent = "Show";
      btn.setAttribute("aria-label", `Show the value of ${ph}`);
      const r = revealer(() => { cell.textContent = v; btn.textContent = "Hide"; },
                         () => { cell.textContent = mask(v); btn.textContent = "Show"; });
      btn.addEventListener("click", () => (r.shown ? r.hide() : r.show()));
      const act = tr.insertCell();
      act.className = "act";
      act.appendChild(btn);
    }
  }
  $("reset").addEventListener("click", async () => { await send({ type: "reset" }); drawVault(); doRestore(); });

  // ---------------------------------------------------------------- settings
  // The word lists are encrypted; only the service worker can read or write them.
  const s = await chrome.storage.local.get({ guardTyped: false });
  $("guardTyped").checked = s.guardTyped === true;
  $("guardTyped").addEventListener("change", () => chrome.storage.local.set({ guardTyped: $("guardTyped").checked }));
  $("more").addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  // The lists are shown as a count plus dots. Their entries are only put into the page while
  // revealed, and taken out again when hidden.
  const summary = n => (n ? `${n} ${n === 1 ? "entry" : "entries"}  ${"•".repeat(Math.min(12, 4 + n))}` : "Empty");
  let counts = { terms: 0, allow: 0 };
  function drawMasks() {
    $("termsMask").textContent = summary(counts.terms);
    $("allowMask").textContent = summary(counts.allow);
  }

  async function loadLists() {
    const st = await send({ type: "lists.get" });
    const usable = !st.locked && !st.broken;
    $("lockBanner").hidden = !st.locked;
    $("lockedBox").hidden = usable;
    $("listsBox").hidden = !usable;
    $("listsToggle").hidden = !usable;
    $("lockNow").hidden = !(usable && st.mode === "password");
    $("unlockForm").hidden = !st.locked;
    if (st.broken) {
      $("lockedTitle").textContent = "Your custom lists can't be decrypted";
      $("lockedText").textContent = "Their key is gone (browser data was cleared). Pastes are still scrubbed with the built-in rules. Delete the lists under Password & backup to start over.";
    }
    if (usable) counts = { terms: st.terms.length, allow: st.allow.length };
    drawMasks();
    return st;
  }
  await loadLists();
  $("lockBanner").addEventListener("click", () => { show("settings"); $("unlockPw").focus(); });

  let t = 0, pending = null;
  function saveNow() {
    clearTimeout(t);
    t = 0;
    const terms = lines($("terms").value), allow = lines($("allow").value);
    counts = { terms: terms.length, allow: allow.length };
    pending = send({ type: "lists.set", terms, allow }).then(() => {
      $("saved").textContent = "Saved";
    }, e => {
      $("saved").textContent = e.message === "locked" ? "Locked: not saved" : "Not saved";
    }).then(() => setTimeout(() => $("saved").textContent = "", 1500));
    return pending;
  }
  function save() {
    listsReveal.bump();
    clearTimeout(t);
    t = setTimeout(saveNow, 300);
  }
  const listsReveal = revealer(async () => {
    const st = await send({ type: "lists.get" });
    if (!st.terms) return loadLists();
    $("terms").value = st.terms.join("\n");
    $("allow").value = st.allow.join("\n");
    for (const id of ["terms", "allow"]) { $(id).hidden = false; $(id + "Mask").hidden = true; }
    $("listsToggle").textContent = "Hide";
  }, async () => {
    if (t) await saveNow(); // keep edits made just before hiding
    for (const id of ["terms", "allow"]) { $(id).value = ""; $(id).hidden = true; $(id + "Mask").hidden = false; }
    $("listsToggle").textContent = "Show and edit";
    drawMasks();
  });
  $("listsToggle").addEventListener("click", () => (listsReveal.shown ? listsReveal.hide() : listsReveal.show()));
  for (const id of ["terms", "allow"]) {
    $(id).addEventListener("input", save);
    $(id).addEventListener("focus", () => listsReveal.bump());
  }

  $("unlockForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("unlockMsg").textContent = "Unlocking…";
    try {
      await send({ type: "lock.unlock", password: $("unlockPw").value });
      $("unlockMsg").textContent = "";
    } catch (_) {
      $("unlockMsg").textContent = "Wrong password.";
    }
    $("unlockPw").value = "";
    loadLists();
  });
  $("lockNow").addEventListener("click", async () => {
    await listsReveal.hide();
    await send({ type: "lock.lock" });
    loadLists();
  });

  // ---------------------------------------------------------------- opened from right-click menu
  if (params.get("view") === "restore") {
    const { pendingRestore = "" } = await chrome.storage.session.get({ pendingRestore: "" });
    await chrome.storage.session.remove("pendingRestore");
    $("restoreIn").value = pendingRestore;
    doRestore();
  }
})();
