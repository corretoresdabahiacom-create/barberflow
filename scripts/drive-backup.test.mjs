import assert from "node:assert/strict";
import test from "node:test";
import { buildMultipart, selectExpired } from "./drive-backup.mjs";

const day = 86400_000;
const now = Date.UTC(2026, 10, 9);
const f = (name, ageDays) => ({ id: name, name, createdTime: new Date(now - ageDays * day).toISOString() });

test("retenção apaga só o que é do app, antigo, e preserva os mais novos", () => {
  const files = [f("naregua-d1-a", 1), f("naregua-d1-b", 2), f("naregua-d1-c", 3), f("naregua-d1-d", 40), f("naregua-d1-e", 60), f("foto-da-familia.jpg", 400)];
  const out = selectExpired(files, { prefix: "naregua-d1-", retentionDays: 30, nowMs: now }).map((x) => x.name).sort();
  assert.deepEqual(out, ["naregua-d1-d", "naregua-d1-e"]);
});

test("nunca apaga os N mais recentes, mesmo velhos", () => {
  const files = [f("naregua-d1-a", 100), f("naregua-d1-b", 200), f("naregua-d1-c", 300)];
  assert.deepEqual(selectExpired(files, { prefix: "naregua-d1-", retentionDays: 30, nowMs: now, keepLatest: 3 }), []);
});

test("multipart contém metadados, bytes e delimitador final", () => {
  const body = buildMultipart("B", { name: "x.enc", parents: ["pasta"] }, Buffer.from([1, 2, 3]));
  const s = body.toString("latin1");
  assert.ok(s.startsWith("--B\r\n"));
  assert.ok(s.includes('"parents":["pasta"]'));
  assert.ok(s.endsWith("\r\n--B--"));
  assert.ok(body.includes(Buffer.from([1, 2, 3])));
});
