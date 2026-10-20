import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeCheckSurface,
  diffCheckSurface,
  lockCheckSurface,
} from "../lib/check-surface.mjs";

const SHA = /^[a-f0-9]{64}$/;

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-surface-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".ratchet"), { recursive: true });
  return root;
}

function write(root, file, content = "") {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function config(root) {
  write(root, ".ratchet/config.json", JSON.stringify({ version: 1, checks: [] }, null, 2));
}

test("surface: config and package scripts are hashed, other package fields are not", (t) => {
  const root = repo(t);
  config(root);
  write(root, "package.json", JSON.stringify({ name: "a", scripts: { check: "node check.mjs", test: "node --test" } }));

  const surface = computeCheckSurface(root, []);
  assert.match(surface.config, SHA);
  assert.match(surface.scripts, SHA);

  write(root, "package.json", JSON.stringify({ name: "b", scripts: { test: "node --test", check: "node check.mjs" } }));
  assert.equal(computeCheckSurface(root, []).scripts, surface.scripts);

  write(root, "package.json", JSON.stringify({ name: "b", scripts: { check: "node other.mjs" } }));
  assert.notEqual(computeCheckSurface(root, []).scripts, surface.scripts);
});

test("surface: missing config and package.json hash to null", (t) => {
  const root = repo(t);
  const surface = computeCheckSurface(root, []);
  assert.equal(surface.config, null);
  assert.equal(surface.scripts, null);
  assert.match(surface.verify, SHA);
  assert.deepEqual(surface.files, {});
});

test("surface: only files referenced by verify commands are hashed", (t) => {
  const root = repo(t);
  config(root);
  write(root, "check.mjs", "process.exit(0)\n");
  write(root, "scripts/lint.sh", "exit 0\n");
  write(root, "src/a.ts", "export const a = 1\n");
  write(root, "README.md", "# x\n");

  const surface = computeCheckSurface(root, ["node check.mjs", "bash scripts/lint.sh"]);
  assert.deepEqual(Object.keys(surface.files), ["check.mjs", "scripts/lint.sh"]);
  assert.match(surface.files["check.mjs"], SHA);
});

test("surface: flags, runners, directories, missing files, and outside paths are skipped", (t) => {
  const root = repo(t);
  config(root);
  write(root, "check.mjs", "process.exit(0)\n");
  fs.mkdirSync(path.join(root, "nested.mjs"));

  const surface = computeCheckSurface(root, [
    "node --test check.mjs",
    "npm run test",
    "node nested.mjs",
    "node missing.mjs",
    `node ${path.join(os.tmpdir(), "outside.mjs")}`,
  ]);
  assert.deepEqual(Object.keys(surface.files), ["check.mjs"]);
});

test("surface: the lock hashes the stable surface and moves when a check file moves", (t) => {
  const root = repo(t);
  config(root);
  write(root, "check.mjs", "process.exit(0)\n");

  const first = lockCheckSurface(root, ["node check.mjs"]);
  assert.match(first.sha256, SHA);
  assert.equal(lockCheckSurface(root, ["node check.mjs"]).sha256, first.sha256);

  write(root, "check.mjs", "process.exit(1)\n");
  const second = lockCheckSurface(root, ["node check.mjs"]);
  assert.notEqual(second.sha256, first.sha256);
});

test("surface: diff names config, scripts, and file changes", (t) => {
  const root = repo(t);
  config(root);
  write(root, "check.mjs", "process.exit(0)\n");
  write(root, "old.mjs", "process.exit(0)\n");
  write(root, "package.json", JSON.stringify({ scripts: { check: "node check.mjs" } }));

  const locked = lockCheckSurface(root, ["node check.mjs old.mjs"]);
  write(root, "check.mjs", "process.exit(1)\n");
  write(root, "new.mjs", "process.exit(0)\n");
  fs.rmSync(path.join(root, "old.mjs"));
  write(root, "package.json", JSON.stringify({ scripts: { check: "node check.mjs new.mjs" } }));
  write(root, ".ratchet/config.json", JSON.stringify({ version: 1, checks: [{ id: "x", cmd: "node check.mjs" }] }));

  assert.deepEqual(diffCheckSurface(locked, computeCheckSurface(root, ["node check.mjs new.mjs"])), [
    "config changed",
    "package scripts changed",
    "verify commands changed",
    "changed check file: check.mjs",
    "removed check file: old.mjs",
  ]);
});

test("surface: the verify command list is part of the lock", (t) => {
  const root = repo(t);
  config(root);
  write(root, "check.mjs", "process.exit(0)\n");
  const locked = lockCheckSurface(root, ["node check.mjs"]);

  assert.deepEqual(diffCheckSurface(locked, computeCheckSurface(root, ["true check.mjs"])), [
    "verify commands changed",
  ]);
});

test("surface: an added check file does not invalidate a generated artifact", (t) => {
  const root = repo(t);
  config(root);
  const locked = lockCheckSurface(root, ["bend PROOF.bend --check-only"]);
  write(root, "PROOF.bend", "proof\n");
  assert.deepEqual(diffCheckSurface(locked, computeCheckSurface(root, ["bend PROOF.bend --check-only"])), []);
});

test("surface: an untouched repository diffs to nothing", (t) => {
  const root = repo(t);
  config(root);
  write(root, "check.mjs", "process.exit(0)\n");
  write(root, "package.json", JSON.stringify({ scripts: { check: "node check.mjs" } }));

  const locked = lockCheckSurface(root, ["node check.mjs"]);
  assert.deepEqual(diffCheckSurface(locked, computeCheckSurface(root, ["node check.mjs"])), []);
});
