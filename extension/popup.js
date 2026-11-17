/* PromptVeil popup. Restoring happens only here (or in the restore window), never in the AI site's page. */
(async () => {
  "use strict";
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const send = msg => chrome.runtime.sendMessage(msg).then(r => { if (r && r.error) throw new Error(r.error); return r; });
  const lines = s => s.split("\n").map(x => x.trim()).filter(Boolean);
  const SUPPORTED = (chrome.runtime.getManifest().host_permissions || []).map(p => new URL(p.replace("/*", "/")).hostname);
  if (params.get("window")) document.body.classList.add("window");
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
    const label = () => { $("siteTxt").innerHTML = ""; const b = document.createElement("b"); b.textContent = host;
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
  $("restoreCopy").addEventListener("click", e => copy(restored, e.currentTarget));

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
    if (!entries.length) { const td = tb.insertRow().insertCell(); td.colSpan = 2; td.style.color = "var(--mute)"; td.textContent = "Empty. Nothing has been hidden yet."; return; }
    for (const [ph, v] of entries) { const tr = tb.insertRow(); tr.insertCell().textContent = ph; tr.insertCell().textContent = $("reveal").checked ? v : mask(v); }
  }
  $("reveal").addEventListener("change", drawVault);
  $("reset").addEventListener("click", async () => { await send({ type: "reset" }); drawVault(); doRestore(); });

  // ---------------------------------------------------------------- settings
  const s = await chrome.storage.local.get({ terms: [], allow: [], guardTyped: false });
  $("terms").value = s.terms.join("\n");
  $("allow").value = s.allow.join("\n");
  $("guardTyped").checked = s.guardTyped === true;
  $("guardTyped").addEventListener("change", () => chrome.storage.local.set({ guardTyped: $("guardTyped").checked }));
  let t;
  function save() {
    clearTimeout(t);
    t = setTimeout(async () => {
      await chrome.storage.local.set({ terms: lines($("terms").value), allow: lines($("allow").value) });
      $("saved").textContent = "Saved";
      setTimeout(() => $("saved").textContent = "", 1000);
    }, 300);
  }
  $("terms").addEventListener("input", save);
  $("allow").addEventListener("input", save);

  // ---------------------------------------------------------------- opened from right-click menu
  if (params.get("view") === "restore") {
    const { pendingRestore = "" } = await chrome.storage.session.get({ pendingRestore: "" });
    await chrome.storage.session.remove("pendingRestore");
    $("restoreIn").value = pendingRestore;
    doRestore();
  }
})();
