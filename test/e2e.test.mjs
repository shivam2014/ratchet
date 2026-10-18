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

test("install: opencode plugin, kill switch, uninstall", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const install = ratchet(dir, ["install", "--harness", "opencode", "--project", "--yes"]);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.existsSync(path.join(dir, ".opencode/plugins/ratchet.js")), true);
  assert.match(fs.readFileSync(path.join(dir, ".opencode/plugins/ratchet.js"), "utf8"), /id: "ratchet"/);
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/ratchet-mode")), true);

  assert.equal(ratchet(dir, ["disable", "--reason", "test"]).status, 0);
  const allowed = ratchet(dir, ["guard"], event("write", { path: "lib/x.ts" }, dir));
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /disabled/);

  ratchet(dir, ["enable"]);
  const blocked = ratchet(dir, ["guard"], event("write", { path: "lib/x.ts" }, dir));
  assert.equal(blocked.status, 2);

  const status = ratchet(dir, ["status"]);
  assert.match(status.stdout, /opencode/);

  const un = ratchet(dir, ["uninstall", "--harness", "opencode", "--project"]);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(path.join(dir, ".opencode/plugins/ratchet.js")), false);
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/ratchet-mode")), false);
});

test("install: claude hook is idempotent and preserves settings", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const claude = path.join(dir, ".claude/settings.json");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2));

  assert.equal(ratchet(dir, ["install", "--harness", "claude", "--project", "--yes"]).status, 0);
  const first = JSON.parse(fs.readFileSync(claude, "utf8"));
  assert.deepEqual(first.permissions, { allow: ["Bash(ls)"] });
  assert.equal(first.hooks.PreToolUse.length, 1);

  assert.equal(ratchet(dir, ["install", "--harness", "claude", "--project", "--yes"]).status, 0);
  const second = JSON.parse(fs.readFileSync(claude, "utf8"));
  assert.equal(second.hooks.PreToolUse.length, 1);
});

test("install: codex hook is merged, idempotent, and removable", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const hooksFile = path.join(dir, ".codex/hooks.json");
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PostToolUse: [] } }, null, 2));

  assert.equal(ratchet(dir, ["install", "--harness", "codex", "--project", "--yes"]).status, 0);
  const first = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(first.hooks.PostToolUse.length, 0);
  assert.equal(first.hooks.PreToolUse.length, 1);
  assert.match(first.hooks.PreToolUse[0].hooks[0].command, /adapters\/codex\/hook\.mjs/);

  assert.equal(ratchet(dir, ["install", "--harness", "codex", "--project", "--yes"]).status, 0);
  const second = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(second.hooks.PreToolUse.length, 1);

  assert.equal(ratchet(dir, ["uninstall", "--harness", "codex", "--project"]).status, 0);
  const third = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(third.hooks.PreToolUse.length, 0);
});

test("guard: claude format allows in scope and denies out of scope", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  ratchet(dir, ["task", "start", "--role", "coder", "--goal", "g", "--scope", "src/**"]);

  const deny = ratchet(
    dir,
    ["guard", "--format", "claude"],
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "outside.txt" }, cwd: dir }),
  );
  assert.equal(deny.status, 0);
  const denied = JSON.parse(deny.stdout);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /outside scope/);

  const allow = ratchet(
    dir,
    ["guard", "--format", "claude"],
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/a.ts" }, cwd: dir }),
  );
  assert.equal(allow.status, 0);
  assert.equal(allow.stdout.trim(), "");
});

test("e2e: --pstack gate blocks source until the plan and sketch exist", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const start = ratchet(dir, ["task", "start", "--role", "coder", "--goal", "g", "--scope", "src/**", "--pstack"]);
  assert.equal(start.status, 0, start.stderr);

  const blocked = ratchet(dir, ["guard"], event("write", { path: "src/a.ts" }, dir));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Skill gate/);

  const plan = ratchet(dir, ["guard"], event("write", { path: ".ratchet/plan.md", content: "# Plan" }, dir));
  assert.equal(plan.status, 0, plan.stderr);

  fs.mkdirSync(path.join(dir, ".ratchet"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ratchet/plan.md"), "# Plan\n");
  fs.writeFileSync(path.join(dir, ".ratchet/sketch.md"), "# Sketch\n");

  const allowed = ratchet(dir, ["guard"], event("write", { path: "src/a.ts" }, dir));
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("install: dry run writes nothing", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const result = ratchet(dir, ["install", "--harness", "opencode", "--project", "--yes", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run/);
  assert.equal(fs.existsSync(path.join(dir, ".opencode/plugins/ratchet.js")), false);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet/install.json")), false);
});
