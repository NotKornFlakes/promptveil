// Tests extension/crypto.js (word-list encryption and backups) with Node's WebCrypto.
// Run: node --test tests/extension_crypto.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

vm.runInThisContext(readFileSync(new URL("../extension/crypto.js", import.meta.url), "utf8"));
const C = globalThis.PromptVeilCrypto;
const LISTS = { terms: ["Marcus Bell", "Riverside Dental"], allow: ["support@example.com"] };

test("device mode: round trip, fresh IV on every save", async () => {
  const key = await C.newDeviceKey();
  const a = await C.sealLists(key, "device", LISTS);
  const b = await C.sealLists(key, "device", LISTS);
  assert.equal(a.v, 1);
  assert.equal(a.mode, "device");
  assert.equal(C.unb64(a.iv).length, 12);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.ok(!JSON.stringify(a).includes("Marcus"));
  assert.deepEqual(await C.openLists(key, a), LISTS);
});

test("device key is not extractable", async () => {
  const key = await C.newDeviceKey();
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", key));
});

test("password mode: PBKDF2-SHA256, 600,000 iterations, 16-byte salt; wrong password fails cleanly", async () => {
  assert.ok(C.ITERATIONS >= 600000);
  const salt = C.random(16);
  const key = await C.keyFromBytes(await C.deriveKeyBytes("correct horse", salt));
  const sealed = await C.sealLists(key, "password", LISTS, { salt, iterations: C.ITERATIONS });
  assert.deepEqual(sealed.kdf, { name: "PBKDF2-SHA256", iterations: C.ITERATIONS, salt: C.b64(salt) });
  assert.equal(C.unb64(sealed.kdf.salt).length, 16);

  const again = await C.keyFromBytes(await C.deriveKeyBytes("correct horse", C.unb64(sealed.kdf.salt), sealed.kdf.iterations));
  assert.deepEqual(await C.openLists(again, sealed), LISTS);

  const wrong = await C.keyFromBytes(await C.deriveKeyBytes("wrong horse", salt));
  await assert.rejects(C.openLists(wrong, sealed), { message: "wrong key" });
});

test("tampering and relabelling the mode are detected", async () => {
  const key = await C.newDeviceKey();
  const sealed = await C.sealLists(key, "device", LISTS);
  const ct = C.unb64(sealed.ct);
  ct[0] ^= 1;
  await assert.rejects(C.openLists(key, { ...sealed, ct: C.b64(ct) }), { message: "wrong key" });
  await assert.rejects(C.openLists(key, { ...sealed, mode: "password" }), { message: "wrong key" });
});

test("empty passwords are refused", async () => {
  await assert.rejects(C.deriveKeyBytes("", C.random(16)), { message: "empty password" });
});

test("cleanLists keeps only trimmed, non-empty strings", () => {
  assert.deepEqual(C.cleanLists({ terms: [" a ", "", 3, null, "b"], allow: "nope" }), { terms: ["a", "b"], allow: [] });
});

test("backup: round trip, wrong password, not a backup", async () => {
  const file = await C.exportBackup(LISTS, "backup password");
  const parsed = JSON.parse(file);
  assert.equal(parsed.format, "promptveil-lists-backup");
  assert.equal(parsed.kdf.iterations, C.ITERATIONS);
  assert.ok(!file.includes("Marcus"));
  assert.deepEqual(await C.importBackup(file, "backup password"), LISTS);
  await assert.rejects(C.importBackup(file, "not it at all"), { message: "wrong key" });
  await assert.rejects(C.importBackup("{}", "x"), { message: "not a PromptVeil backup" });
  await assert.rejects(C.importBackup("not json", "x"), { message: "not a PromptVeil backup" });
  await assert.rejects(C.importBackup(JSON.stringify({ ...parsed, kdf: { ...parsed.kdf, iterations: 1 } }), "backup password"),
    { message: "not a PromptVeil backup" });
});

test("sha256 is stable and base64", async () => {
  assert.equal(await C.sha256("abc"), "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
});
