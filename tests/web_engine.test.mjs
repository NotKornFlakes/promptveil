// Tests the JS engine embedded in web/index.html and checks it agrees with the Python engine.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const src = html.match(/<script id="engine">([\s\S]*?)<\/script>/)[1];
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const { Veil } = ctx.PromptVeil;

const SAMPLE = `Hi team, customer Jane Doe (jane.doe@acme.com, 555-867-5309) reported login failures.
Her card 4111 1111 1111 1111 was charged twice. SSN on file: 123-45-6789.
Server db01.corp at 10.0.4.12 logs show key AKIAIOSFODNN7EXAMPLE and
password = Sup3rS3cret! in config. Reply to JANE.DOE@acme.com.
DB: postgres://admin:hunter2pass@10.0.4.12:5432/prod
key ghp_${"a".repeat(36)} jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijk mac 00:1A:2B:3C:4D:5E
v 1.2.3.4.5 bad card 4111 1111 1111 1112
`;

test("round trip", () => {
  const v = new Veil();
  const { text } = v.scrub("Email bob@x.io or call 212-555-0199 from 192.168.1.20");
  assert.equal(text, "Email [EMAIL_1] or call [PHONE_1] from [IP_1]");
  const r = v.restore("I'll email [EMAIL_1] and call PHONE_1 about IP_1. IP_10 untouched.");
  assert.equal(r.text, "I'll email bob@x.io and call 212-555-0199 about 192.168.1.20. IP_10 untouched.");
  assert.equal(r.count, 3);
});

test("terms and allow list", () => {
  const v = new Veil({ terms: ["Project Falcon", "Acme"], allow: ["10.0.0.1"] });
  assert.equal(v.scrub("Acme's project falcon runs on 10.0.0.1").text, "[TERM_1]'s [TERM_2] runs on 10.0.0.1");
});

test("matches the Python engine byte-for-byte", () => {
  const terms = ["Jane Doe"];
  const js = new Veil({ terms }).scrub(SAMPLE).text;
  const py = execFileSync("python3", ["-c",
    "import sys,json; sys.path.insert(0,'src'); from promptveil import Veil; " +
    "t=json.loads(sys.argv[1]); print(Veil(terms=t['terms']).scrub(t['text'])[0], end='')",
    JSON.stringify({ text: SAMPLE, terms })], { encoding: "utf8" });
  assert.equal(js, py);
  assert.ok(!js.includes("hunter2pass") && !js.includes("Sup3rS3cret") && js.includes("1.2.3.4.5"));
});
