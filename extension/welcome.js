/* PromptVeil welcome page. The demo uses its own throwaway Veil, so nothing typed here
 * reaches the real vault or the service worker. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const SAMPLE = "Customer dana.reyes@example.com (phone 415-555-0134) can't reach db01.corp at 10.0.4.12 since Monday.\n" +
    "Card on file 4111 1111 1111 1111. Our key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWx.";

  chrome.commands.getAll().then(cmds => {
    const c = cmds.find(x => x.name === "restore-selection");
    $("shortcut").textContent = c && c.shortcut ? c.shortcut : "a shortcut you set at chrome://extensions/shortcuts";
  }).catch(() => {});

  function paint(el, parts) {
    el.textContent = "";
    for (const p of parts) {
      if (!p.text) continue;
      if (p.ph || p.real) {
        const m = document.createElement("mark");
        if (p.real) m.className = "real";
        m.textContent = p.text;
        el.appendChild(m);
      } else {
        el.appendChild(document.createTextNode(p.text));
      }
    }
  }

  let veil = new PromptVeil.Veil();
  let answerEdited = false;

  function draftAnswer(placeholders) {
    if (!placeholders.length) return "";
    return "Thanks. Here's what I'd check, in order:\n" + placeholders.map((p, i) => `${i + 1}. ${p}`).join("\n");
  }

  function update() {
    veil = new PromptVeil.Veil(); // fresh each time: the demo never keeps anything
    const { parts, findings } = veil.scrubParts($("demoIn").value);
    paint($("demoScrubbed"), parts);
    $("demoMeta").textContent = $("demoIn").value
      ? `${findings.length} item${findings.length === 1 ? "" : "s"} hidden`
      : "";
    if (!answerEdited) {
      const unique = [...new Set(parts.filter(p => p.ph).map(p => p.text))];
      $("demoAnswer").value = draftAnswer(unique);
    }
    restore();
  }

  function restore() {
    paint($("demoRestored"), veil.restoreParts($("demoAnswer").value).parts);
  }

  $("demoIn").addEventListener("input", update);
  $("demoAnswer").addEventListener("input", () => { answerEdited = $("demoAnswer").value !== ""; restore(); });
  $("sample").addEventListener("click", () => {
    $("demoIn").value = SAMPLE;
    answerEdited = false;
    update();
  });
})();
