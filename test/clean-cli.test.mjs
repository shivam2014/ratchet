import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-clean-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "tracked.txt"), "base\n");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "clean-cli", private: true }, null, 2),
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

function git(dir, args) {
  return spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8" },
  );
}

function ratchet(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

function start(dir, extra = []) {
  return ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "clean check",
    "--scope", "**",
    "--verify", "node --version",
    ...extra,
  ]);
}

test("clean-cli: a dirty tree refuses a clean contract", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "dirty\n");

  const result = start(dir, ["--require-clean"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a clean tree/);
  assert.match(result.stderr, /tracked\.txt/);
});

test("clean-cli: check and done refuse while tracked files are modified", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir, ["--require-clean"]).status, 0);

  fs.writeFileSync(path.join(dir, "tracked.txt"), "work\n");
  const check = ratchet(dir, ["check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /requires a clean tree/);

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "work"]);
  assert.equal(ratchet(dir, ["check"]).status, 0);
  assert.equal(ratchet(dir, ["done"]).status, 0);
});
