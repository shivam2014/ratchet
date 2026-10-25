import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadRunForSession } from "../lib/contract.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function session(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "lifecycle", private: true }, null, 2),
  );
  return dir;
}

function ratchet(cwd, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: "utf8" });
}

function start(dir, goal) {
  return ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", goal,
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
}

function current(dir) {
  const file = path.join(dir, ".ratchet", "current");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

test("lifecycle: done releases the contract pointer", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir, "close me").status, 0);

  const id = current(dir);
  assert.ok(id);

  assert.equal(ratchet(dir, ["check"]).status, 0);
  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /released/);

  assert.equal(current(dir), null);
  const status = ratchet(dir, ["status"]);
  assert.match(status.stdout, /contract: none/);
  assert.ok(fs.existsSync(path.join(dir, ".ratchet", "runs", id, "result.json")));
});

test("lifecycle: a finished run no longer resolves as the active contract", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir, "finished").status, 0);
  const id = current(dir);

  assert.equal(loadRunForSession(dir, null)?.id, id);

  assert.equal(ratchet(dir, ["check"]).status, 0);
  assert.equal(ratchet(dir, ["done"]).status, 0);

  assert.equal(loadRunForSession(dir, null), null);

  const write = ratchet(
    dir,
    ["hook"],
    JSON.stringify({ type: "tool.before", harness: "test", session_id: "s-1", tool: "write", input: { path: "outside.txt" }, cwd: dir }),
  );
  assert.equal(write.status, 2);
  assert.match(write.stderr, /No active task contract/);
  assert.equal(fs.existsSync(path.join(dir, "outside.txt")), false);
});

test("lifecycle: the next task starts after done", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir, "first").status, 0);
  const first = current(dir);

  assert.equal(ratchet(dir, ["check"]).status, 0);
  assert.equal(ratchet(dir, ["done"]).status, 0);

  const next = start(dir, "second");
  assert.equal(next.status, 0, next.stderr);
  const second = current(dir);
  assert.ok(second);
  assert.notEqual(second, first);
});

test("lifecycle: report still resolves the finished run after done", (t) => {
  const dir = session(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(start(dir, "report me").status, 0);
  const id = current(dir);

  assert.equal(ratchet(dir, ["check"]).status, 0);
  assert.equal(ratchet(dir, ["done"]).status, 0);

  const report = ratchet(dir, ["report"]);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, new RegExp(`run:\\s+${id}`));
  assert.match(report.stdout, /goal:\s+report me/);
});
