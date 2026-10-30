import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-precommit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "precommit", private: true, scripts: { test: "node --version" } }, null, 2),
  );
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  return dir;
}

function ratchet(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

function start(dir, scope = "src/**") {
  return ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "precommit test",
    "--scope", scope,
    "--verify", "node --version",
  ]);
}

function stage(dir, rel) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x\n");
  const add = spawnSync("git", ["add", rel], { cwd: dir, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
}

test("pre-commit: an in-scope staged file runs the verify command", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir).status, 0);
  stage(dir, "src/a.ts");

  const hook = ratchet(dir, ["hook", "pre-commit"]);
  assert.equal(hook.status, 0, hook.stdout + hook.stderr);
  assert.match(hook.stdout, /pre-commit: pass/);
  assert.match(hook.stdout, /PASS  verify-1/);
});

test("pre-commit: a staged file outside scope is refused before checks run", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir).status, 0);
  stage(dir, "outside.txt");

  const hook = ratchet(dir, ["hook", "pre-commit"]);
  assert.equal(hook.status, 1);
  assert.match(hook.stdout, /outside scope/);
  assert.match(hook.stdout, /outside\.txt/);
  assert.doesNotMatch(hook.stdout, /PASS  verify-1/);
});

test("pre-commit: runtime state is never committed", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir).status, 0);
  fs.writeFileSync(path.join(dir, ".ratchet", "current"), "fake\n");
  spawnSync("git", ["add", "-f", ".ratchet/current"], { cwd: dir });

  const hook = ratchet(dir, ["hook", "pre-commit"]);
  assert.equal(hook.status, 1);
  assert.match(hook.stdout, /guard state is staged/);
  assert.match(hook.stdout, /\.ratchet\/current/);
});

test("pre-commit: with no contract the config checks still run", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  stage(dir, "outside.txt");

  const hook = ratchet(dir, ["hook", "pre-commit"]);
  assert.equal(hook.status, 0, hook.stdout + hook.stderr);
  assert.match(hook.stdout, /no active contract/);
  assert.match(hook.stdout, /pre-commit: pass/);
});

test("init: runtime state is ignored from the first commit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-precommit-init-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const init = ratchet(dir, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  const ignore = fs.readFileSync(path.join(dir, ".ratchet", ".gitignore"), "utf8");
  assert.match(ignore, /^current$/m);
  assert.match(ignore, /^install\.json$/m);
});
