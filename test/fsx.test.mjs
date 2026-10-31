import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendJsonl,
  findRoot,
  readJson,
  readJsonl,
  repoRel,
  slug,
  timestampId,
  toPosix,
  writeJson,
} from "../lib/fsx.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-fsx-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("fsx: findRoot finds .ratchet up the tree", (t) => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, ".ratchet"));
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRoot(nested), root);
});

test("fsx: findRoot falls back to .git", (t) => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, ".git"));
  assert.equal(findRoot(root), root);
});

test("fsx: repoRel is relative inside and absolute outside", (t) => {
  const root = temp(t);
  assert.equal(repoRel(root, path.join(root, "src/a.ts")), "src/a.ts");
  const outside = path.join(os.homedir(), "notes.txt");
  assert.equal(repoRel(root, outside), toPosix(outside));
});

test("fsx: json round trip and jsonl append", (t) => {
  const root = temp(t);
  const file = path.join(root, "data", "x.json");
  writeJson(file, { a: 1 });
  assert.deepEqual(readJson(file), { a: 1 });

  const jsonl = path.join(root, "events.jsonl");
  appendJsonl(jsonl, { n: 1 });
  appendJsonl(jsonl, { n: 2 });
  assert.deepEqual(readJsonl(jsonl), [{ n: 1 }, { n: 2 }]);
});

test("fsx: slug and timestampId", () => {
  assert.equal(slug("Create ONLY src/inside.txt!"), "create-only-src-inside-txt");
  assert.match(timestampId(new Date(2026, 0, 2, 3, 4, 5)), /^20260102-030405$/);
});
