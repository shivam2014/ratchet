import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function session(t, scripts = { check: "node check.mjs" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "run", private: true, scripts }, null, 2));
  fs.writeFileSync(
    path.join(dir, "check.mjs"),
    'import fs from "node:fs";\nif (!fs.existsSync("src/inside.txt")) process.exit(1);\nif (fs.existsSync("outside.txt")) process.exit(1);\n',
  );
  return dir;
}

function write(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}

function ratchet(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

function result(dir) {
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  return JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "result.json"), "utf8"));
}

test("run: a passing command certifies and records the result", (t) => {
  const dir = session(t);
  write(
    dir,
    "agent.mjs",
    'import fs from "node:fs";\nfs.mkdirSync("src", { recursive: true });\nfs.writeFileSync("src/inside.txt", "hello\\n");\nfs.writeFileSync("run-id.txt", process.env.RATCHET_RUN || "");\n',
  );
  assert.equal(ratchet(dir, ["init"]).status, 0);

  const run = ratchet(dir, [
    "run",
    "--goal", "wrapper",
    "--scope", "src/**",
    "--verify", "node check.mjs",
    "--",
    "node", "agent.mjs",
  ]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /verdict: done/);

  const saved = result(dir);
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  assert.equal(saved.verdict, "done");
  assert.equal(saved.commandStatus, 0);
  assert.equal(saved.checks.ok, true);
  assert.equal(saved.guard, "post-hoc");
  assert.equal(saved.counts.files, null);
  assert.equal(fs.readFileSync(path.join(dir, "run-id.txt"), "utf8"), id);
  const brief = fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "brief.md"), "utf8");
  assert.match(brief, /## Task contract/);
  assert.match(brief, /cannot deny a tool call/);
});

test("run: a failing check fails the wrapper", (t) => {
  const dir = session(t);
  write(dir, "agent.mjs", 'import fs from "node:fs";\nfs.writeFileSync("outside.txt", "leak\\n");\n');
  ratchet(dir, ["init"]);

  const run = ratchet(dir, [
    "run",
    "--goal", "wrapper",
    "--scope", "src/**",
    "--verify", "node check.mjs",
    "--",
    "node", "agent.mjs",
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /verdict: failed/);
  const saved = result(dir);
  assert.equal(saved.verdict, "failed");
  assert.equal(saved.checks.ok, false);
  assert.equal(fs.existsSync(path.join(dir, "outside.txt")), true);
});

test("run: a failing command still records the check result", (t) => {
  const dir = session(t);
  write(
    dir,
    "agent.mjs",
    'import fs from "node:fs";\nfs.mkdirSync("src", { recursive: true });\nfs.writeFileSync("src/inside.txt", "hello\\n");\nprocess.exit(3);\n',
  );
  ratchet(dir, ["init"]);

  const run = ratchet(dir, [
    "run",
    "--goal", "wrapper",
    "--scope", "src/**",
    "--verify", "node check.mjs",
    "--",
    "node", "agent.mjs",
  ]);
  assert.equal(run.status, 1);
  const saved = result(dir);
  assert.equal(saved.commandStatus, 3);
  assert.equal(saved.checks.ok, true);
  assert.equal(saved.verdict, "done");
});

test("run: no verify commands ends uncertified", (t) => {
  const dir = session(t, {});
  write(dir, "agent.mjs", "process.exit(0);\n");
  ratchet(dir, ["init"]);

  const run = ratchet(dir, [
    "run",
    "--goal", "wrapper",
    "--scope", "src/**",
    "--",
    "node", "agent.mjs",
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /verdict: uncertified/);
  const saved = result(dir);
  assert.equal(saved.verdict, "uncertified");
  assert.equal(saved.checks.empty, true);
});
