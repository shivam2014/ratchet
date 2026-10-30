import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isNoopCommand, verifyProblem } from "../lib/verify.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function repo(t, scripts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-verify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "verify", private: true, scripts }, null, 2));
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  assert.equal(ratchet(dir, ["init"]).status, 0);
  return dir;
}

function ratchet(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

function contractOf(dir) {
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  return JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
}

test("verify: the no-op predicate names the commands that cannot fail", () => {
  for (const command of [
    "",
    "   ",
    "true",
    "true;",
    "true --quiet",
    ":",
    ": # no-op",
    ": ignored",
    "echo done",
    "printf ok",
    "exit 0",
    "exit 0 # ok",
    "echo a && true",
  ]) {
    assert.equal(isNoopCommand(command), true, `expected no-op: ${JSON.stringify(command)}`);
  }
  for (const command of ["npm test", "node check.mjs", "echo ok && npm test", "npm test; echo done", "exit 1"]) {
    assert.equal(isNoopCommand(command), false, `expected real check: ${JSON.stringify(command)}`);
  }

  assert.equal(verifyProblem([]).kind, "empty");
  assert.equal(verifyProblem(["npm test"]), null);

  const noop = verifyProblem([{ id: "verify-1", cmd: "true" }, "npm test"]);
  assert.equal(noop.kind, "noop");
  assert.deepEqual(noop.noop, ["true"]);
});

test("verify: a non-read-only start with no verify refuses and names the fix", (t) => {
  const dir = repo(t);

  const start = ratchet(dir, ["task", "start", "--role", "coder", "--goal", "no check", "--scope", "src/**"]);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /REFUSED: no verify command/);
  assert.match(start.stderr, /ratchet task start .*--verify "npm test"/);
  assert.match(start.stderr, /ratchet init/);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);
});

test("verify: no-op verify commands refuse at task start", (t) => {
  const dir = repo(t);
  for (const command of ["true", ":", "echo done", "printf ok", "exit 0", "  "]) {
    const start = ratchet(dir, [
      "task", "start",
      "--role", "coder",
      "--goal", "no-op check",
      "--scope", "src/**",
      "--verify", command,
    ]);
    assert.equal(start.status, 1, `${JSON.stringify(command)} should refuse`);
    assert.match(start.stderr, /REFUSED: verify command cannot fail/);
    assert.match(start.stderr, /ratchet task start .*--verify "npm test"/);
  }
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);
});

test("verify: a read-only contract is exempt from the verify rule", (t) => {
  const dir = repo(t);

  const start = ratchet(dir, [
    "task", "start",
    "--role", "reviewer",
    "--goal", "review the uploader",
    "--scope", "src/**",
  ]);
  assert.equal(start.status, 0, start.stderr);

  const contract = contractOf(dir);
  assert.equal(contract.readOnly, true);
  assert.deepEqual(contract.verify, []);
});

test("verify: config checks satisfy the rule when --verify is omitted", (t) => {
  const dir = repo(t, { check: "node check.mjs" });

  const start = ratchet(dir, ["task", "start", "--role", "coder", "--goal", "configured", "--scope", "src/**"]);
  assert.equal(start.status, 0, start.stderr);

  const contract = contractOf(dir);
  assert.equal(contract.verify.length, 1);
  assert.equal(contract.verify[0].cmd, "npm run check");
});

test("run refuses without a verify command", (t) => {
  const dir = repo(t);

  const run = ratchet(dir, ["run", "--goal", "wrapper", "--scope", "src/**", "--", "node", "-e", "process.exit(0)"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /REFUSED: no verify command/);
  assert.match(run.stderr, /ratchet run .*--verify "npm test"/);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);
});

test("run refuses a no-op verify command", (t) => {
  const dir = repo(t);

  const run = ratchet(dir, [
    "run",
    "--goal", "wrapper",
    "--scope", "src/**",
    "--verify", "true",
    "--",
    "node", "-e", "process.exit(0)",
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /REFUSED: verify command cannot fail/);
  assert.match(run.stderr, /ratchet run .*--verify "npm test"/);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);
});
