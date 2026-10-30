import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function session(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-amend-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "check.mjs"), "process.exit(0)\n");
  return dir;
}

function ratchet(cwd, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: "utf8" });
}

function start(dir, goal = "change a check") {
  const result = ratchet(dir, [
    "task",
    "start",
    "--role",
    "coder",
    "--goal",
    goal,
    "--scope",
    "**",
    "--verify",
    "node check.mjs",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
}

function contractOf(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
}

test("amend: re-baselines an edited check file and records the reason", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const id = start(dir);

  fs.writeFileSync(path.join(dir, "check.mjs"), "// a stronger assertion\nprocess.exit(0)\n");

  const refused = ratchet(dir, ["check"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /check surface changed: changed check file: check\.mjs/);
  assert.match(refused.stderr, /ratchet amend --reason/);

  const amended = ratchet(dir, ["amend", "--reason", "added assertions"]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.match(amended.stdout, /AMENDED/);
  assert.match(amended.stdout, /changed check file: check\.mjs/);

  const contract = contractOf(dir, id);
  assert.equal(contract.checkAmendments.length, 1);
  assert.equal(contract.checkAmendments[0].reason, "added assertions");
  assert.match(contract.checkAmendments[0].from, /^[a-f0-9]{64}$/);
  assert.match(contract.checkAmendments[0].to, /^[a-f0-9]{64}$/);

  assert.equal(ratchet(dir, ["check"]).status, 0);

  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /amended: added assertions/);

  const result = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "result.json"), "utf8"));
  assert.equal(result.verdict, "done");
  assert.equal(result.amendments.length, 1);
});

test("amend: needs a reason and a real change", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);

  const noReason = ratchet(dir, ["amend"]);
  assert.equal(noReason.status, 1);
  assert.match(noReason.stderr, /--reason/);

  const nothing = ratchet(dir, ["amend", "--reason", "nothing moved"]);
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /nothing to amend/);
});

test("abandon: closes the live contract so the next one can start", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const first = start(dir, "first");

  const blocked = ratchet(dir, ["task", "start", "--role", "coder", "--goal", "second", "--scope", "**"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, new RegExp(`a contract is still live: ${first}`));
  assert.match(blocked.stderr, /ratchet abandon --reason/);

  const abandoned = ratchet(dir, ["abandon", "--reason", "superseded by the real fix"]);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.match(abandoned.stdout, /ABANDONED/);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);

  const result = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", first, "result.json"), "utf8"));
  assert.equal(result.verdict, "abandoned");
  assert.equal(result.reason, "superseded by the real fix");

  const second = start(dir, "second");
  assert.notEqual(second, first);
});

test("task start --force: replaces a live contract and marks it abandoned", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const first = start(dir, "first");

  const forced = ratchet(dir, [
    "task", "start", "--force",
    "--role", "coder",
    "--goal", "second",
    "--scope", "**",
    "--verify", "node check.mjs",
  ]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, new RegExp(`superseded: ${first}`));

  const result = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", first, "result.json"), "utf8"));
  assert.equal(result.verdict, "abandoned");
  assert.match(result.reason, /superseded/);
});

test("done: warns when the guard observed no writes", (t) => {  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);
  assert.equal(ratchet(dir, ["check"]).status, 0);

  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /guard observed 0 writes/);
  assert.match(done.stdout, /ratchet install --harness opencode/);
});
