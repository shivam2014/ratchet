import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { cleanViolation, trackedChanges } from "../lib/clean.mjs";

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-clean-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "tracked.txt"), "base\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  return dir;
}

test("clean: a clean tree has no violation", (t) => {
  const dir = repo(t);
  assert.deepEqual(trackedChanges(dir), []);
  assert.equal(cleanViolation(dir, { id: "r", requireClean: true }), null);
});

test("clean: a tracked modification refuses a clean contract", (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "changed\n");
  assert.deepEqual(trackedChanges(dir), ["tracked.txt"]);
  assert.match(cleanViolation(dir, { id: "r", requireClean: true }), /requires a clean tree/);
});

test("clean: untracked files do not count", (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
  assert.deepEqual(trackedChanges(dir), []);
});

test("clean: a contract without the flag is unaffected", (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "changed\n");
  assert.equal(cleanViolation(dir, { id: "r" }), null);
});
