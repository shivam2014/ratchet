import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function session() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { check: 'node -e "process.exit(0)"' } }, null, 2),
  );
  return dir;
}

function ratchet(cwd, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: "utf8" });
}

function event(tool, input, cwd) {
  return JSON.stringify({ harness: "test", tool, input, cwd });
}

test("e2e: contract allows in-scope, blocks out-of-scope, records evidence", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "add a file",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(start.status, 0, start.stderr);

  const prompt = ratchet(dir, ["prompt"]);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /Goal: add a file/);
  assert.match(prompt.stdout, /Write scope: src\/\*\*/);

  const ok = ratchet(dir, ["guard"], event("write", { path: "src/a.ts", content: "x" }, dir));
  assert.equal(ok.status, 0, ok.stderr);

  const bad = ratchet(dir, ["guard"], event("write", { path: "lib/a.ts", content: "x" }, dir));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /outside scope/);

  const read = ratchet(dir, ["guard"], event("read", { path: "lib/a.ts" }, dir));
  assert.equal(read.status, 0);

  const check = ratchet(dir, ["check"]);
  assert.equal(check.status, 0, check.stderr);

  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /DONE/);

  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const result = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "result.json"), "utf8"));
  assert.equal(result.verdict, "done");
  assert.equal(result.counts.files, 1);
});

test("e2e: failing check refuses done", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "fail the check",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(1)"',
  ]);
  assert.equal(start.status, 0, start.stderr);

  const check = ratchet(dir, ["check"]);
  assert.equal(check.status, 1);

  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /REFUSED/);
});

test("e2e: no contract means no writes", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const blocked = ratchet(dir, ["guard"], event("write", { path: "src/a.ts" }, dir));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /No active task contract/);
});

test("e2e: budget stops runaway edits", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "budget",
    "--scope", "src/**",
    "--max-files", "1",
    "--max-writes", "1",
  ]);
  assert.equal(ratchet(dir, ["guard"], event("write", { path: "src/a.ts" }, dir)).status, 0);
  const second = ratchet(dir, ["guard"], event("write", { path: "src/b.ts" }, dir));
  assert.equal(second.status, 2);
  assert.match(second.stderr, /budget/i);
});

test("e2e: audit rejects a rule with no mechanism", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  fs.appendFileSync(
    path.join(dir, ".ratchet", "rules.tsv"),
    "no-floating-promises\tlint\t\t\n",
  );
  const audit = ratchet(dir, ["audit"]);
  assert.equal(audit.status, 1);
  assert.match(audit.stdout, /no enforcing mechanism/);
});

test("e2e: sync is idempotent and detects drift", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  assert.equal(ratchet(dir, ["sync"]).status, 0);
  const first = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.equal(ratchet(dir, ["sync"]).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), first);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), first.replace("Every non-trivial task", "Every task"));
  assert.equal(ratchet(dir, ["sync", "--check"]).status, 1);
});
