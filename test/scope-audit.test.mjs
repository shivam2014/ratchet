import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { changedPaths, scopeViolations } from "../lib/scope-audit.mjs";

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("scope audit: dirty paths outside scope are violations", (t) => {
  const dir = repo(t);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(dir, "outside.txt"), "x\n");

  assert.deepEqual(changedPaths(dir).sort(), ["outside.txt", "src/a.ts"]);
  assert.deepEqual(scopeViolations(dir, { scope: ["src/**"] }), ["outside.txt"]);
});

test("scope audit: a broad scope accepts everything", (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "outside.txt"), "x\n");
  assert.deepEqual(scopeViolations(dir, { scope: ["**"] }), []);
});

test("scope audit: ratchet runtime state is not a violation", (t) => {
  const dir = repo(t);
  fs.mkdirSync(path.join(dir, ".ratchet"));
  fs.writeFileSync(path.join(dir, ".ratchet", "events.jsonl"), "{}\n");
  fs.writeFileSync(path.join(dir, "src.ts"), "x\n");
  assert.deepEqual(scopeViolations(dir, { scope: ["src.ts"] }), []);
});

test("scope audit: no git means no audit, not a crash", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-audit-nogit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(changedPaths(dir), null);
  assert.deepEqual(scopeViolations(dir, { scope: ["src/**"] }), []);
});
