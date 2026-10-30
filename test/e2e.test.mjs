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
  // The audit compares the working tree to the contract. A base commit keeps
  // the fixture files (package.json) from looking like task changes.
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  return dir;
}

function ratchet(cwd, args, input, env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
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

  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const check = ratchet(dir, ["check"]);
  assert.equal(check.status, 0, check.stderr);

  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /DONE/);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);

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

test("e2e: check surface change refuses check and done", () => {
  const dir = session();
  fs.writeFileSync(path.join(dir, "check.mjs"), "process.exit(0)\n");
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "lock the checks",
    "--scope", "src/**",
    "--verify", "node check.mjs",
  ]);
  assert.equal(start.status, 0, start.stderr);

  assert.equal(ratchet(dir, ["check"]).status, 0);

  fs.writeFileSync(path.join(dir, "check.mjs"), "process.exit(0) // weakened\n");
  const check = ratchet(dir, ["check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /check surface changed/);

  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /REFUSED: check surface changed/);
});

test("e2e: a generated proof file does not invalidate the check surface", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "generated proof",
    "--scope", "src/**",
    "--verify", "node check.mjs",
  ]);
  assert.equal(start.status, 0, start.stderr);

  // The lock has no check.mjs yet. The generated file appears later, which is
  // allowed because an addition cannot weaken a check that was already locked.
  fs.writeFileSync(path.join(dir, "check.mjs"), "process.exit(0)\n");
  assert.equal(ratchet(dir, ["check"]).status, 0);
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
  const lifecycle = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

  assert.equal(ratchet(dir, ["install", "--harness", "claude", "--project", "--yes"]).status, 0);
  const first = JSON.parse(fs.readFileSync(claude, "utf8"));
  assert.deepEqual(first.permissions, { allow: ["Bash(ls)"] });
  assert.equal(first.hooks.PreToolUse.length, 1);
  for (const event of lifecycle) assert.equal(first.hooks[event].length, 1, event);

  assert.equal(ratchet(dir, ["install", "--harness", "claude", "--project", "--yes"]).status, 0);
  const second = JSON.parse(fs.readFileSync(claude, "utf8"));
  assert.equal(second.hooks.PreToolUse.length, 1);
  for (const event of lifecycle) assert.equal(second.hooks[event].length, 1, event);

  assert.equal(ratchet(dir, ["uninstall", "--harness", "claude", "--project"]).status, 0);
  const third = JSON.parse(fs.readFileSync(claude, "utf8"));
  assert.deepEqual(third.permissions, { allow: ["Bash(ls)"] });
  for (const event of lifecycle) assert.equal(third.hooks[event].length, 0, event);
});

test("install: codex hook is merged, idempotent, and removable", () => {
  const dir = session();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-codex-home-"));
  const env = { HOME: home, CODEX_HOME: path.join(home, ".codex") };
  ratchet(dir, ["init"], undefined, env);
  const hooksFile = path.join(dir, ".codex/hooks.json");
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PostToolUse: [] } }, null, 2));
  const lifecycle = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

  assert.equal(ratchet(dir, ["install", "--harness", "codex", "--project", "--yes"], undefined, env).status, 0);
  const first = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  for (const event of lifecycle) assert.equal(first.hooks[event].length, 1, event);
  assert.match(first.hooks.PreToolUse[0].hooks[0].command, /adapters\/codex\/hook\.mjs/);

  assert.equal(ratchet(dir, ["install", "--harness", "codex", "--project", "--yes"], undefined, env).status, 0);
  const second = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  for (const event of lifecycle) assert.equal(second.hooks[event].length, 1, event);

  assert.equal(ratchet(dir, ["uninstall", "--harness", "codex", "--project"], undefined, env).status, 0);
  const third = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  for (const event of lifecycle) assert.equal(third.hooks[event].length, 0, event);
});

test("doctor: isolated codex and claude harnesses pass, bad trust fails", () => {
  const dir = session();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-doctor-home-"));
  const env = { HOME: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
  ratchet(dir, ["init"], undefined, env);
  assert.equal(ratchet(dir, ["install", "--harness", "codex,claude", "--user", "--yes"], undefined, env).status, 0);

  const codex = ratchet(dir, ["doctor", "--harness", "codex"], undefined, env);
  assert.equal(codex.status, 0, codex.stdout + codex.stderr);
  const claude = ratchet(dir, ["doctor", "--harness", "claude"], undefined, env);
  assert.equal(claude.status, 0, claude.stdout + claude.stderr);

  const config = path.join(env.CODEX_HOME, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(/sha256:[a-f0-9]+/, "sha256:deadbeef"));
  const bad = ratchet(dir, ["doctor", "--harness", "codex"], undefined, env);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
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

test("claude adapter: no-ops outside a contract, denies inside", () => {
  const dir = session();
  const adapter = path.join(import.meta.dirname, "..", "adapters", "claude", "hook.mjs");
  const claudeEvent = (file) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file }, cwd: dir });

  const noop = spawnSync(process.execPath, [adapter], { input: claudeEvent("x.txt"), encoding: "utf8", cwd: dir });
  assert.equal(noop.status, 0);
  assert.equal(noop.stdout.trim(), "");

  ratchet(dir, ["init"]);
  ratchet(dir, ["task", "start", "--role", "coder", "--goal", "g", "--scope", "src/**"]);

  const deny = spawnSync(process.execPath, [adapter], { input: claudeEvent("outside.txt"), encoding: "utf8", cwd: dir });
  assert.equal(deny.status, 0);
  const parsed = JSON.parse(deny.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /outside scope/);
});

test("e2e: --bend gates Bend code behind LAWS.bend and adds the proof check", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  const start = ratchet(dir, ["task", "start", "--role", "coder", "--goal", "g", "--scope", "**/*.bend", "--bend"]);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /gates:\s+LAWS\.bend/);

  const blocked = ratchet(dir, ["guard"], event("write", { path: "code.bend" }, dir));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /LAWS\.bend/);

  const laws = ratchet(dir, ["guard"], event("write", { path: "LAWS.bend", content: "law x\n" }, dir));
  assert.equal(laws.status, 0, laws.stderr);
  fs.writeFileSync(path.join(dir, "LAWS.bend"), "law x\n");

  const allowed = ratchet(dir, ["guard"], event("write", { path: "code.bend", content: "def x" }, dir));
  assert.equal(allowed.status, 0, allowed.stderr);

  const id = fs.readFileSync(path.join(dir, ".ratchet/current"), "utf8").trim();
  const contract = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet/runs", id, "contract.json"), "utf8"));
  assert.equal(contract.gates[0].artifact, "LAWS.bend");
  assert.ok(contract.verify.some((v) => /PROOF\.bend --check-only/.test(v.cmd)));
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

test("e2e: task start locks the check surface and Stop blocks after the check changes", () => {
  const dir = session();
  ratchet(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "check.mjs"), "process.exit(0)\n");
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "lock the check",
    "--scope", "src/**",
    "--verify", "node check.mjs",
  ]);
  assert.equal(start.status, 0, start.stderr);

  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const contract = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
  assert.deepEqual(Object.keys(contract.checksLock.files), ["check.mjs"]);
  assert.match(contract.checksLock.sha256, /^[a-f0-9]{64}$/);

  const stop = (extra = {}) => ratchet(dir, ["hook"], JSON.stringify({ type: "turn.stop", harness: "test", session_id: "s-1", cwd: dir, ...extra }));

  const first = stop();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).certified, true);
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "checks.json"), "utf8"));

  fs.writeFileSync(path.join(dir, "check.mjs"), "// weakened\nprocess.exit(0)\n");
  const blocked = stop();
  const decision = JSON.parse(blocked.stdout);

  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(decision.allow, false);
  assert.equal(decision.checksLock, "changed");
  assert.equal(decision.evidence, null);
  assert.equal(decision.checks, null);
  assert.match(decision.reason, /^check surface changed: changed check file: check\.mjs\. If intended: ratchet amend/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "checks.json"), "utf8")).ranAt, evidence.ranAt);
});

test("e2e: status detects a user-level adapter with no manifest", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-home-"));
  fs.mkdirSync(path.join(home, ".config", "opencode", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "opencode", "plugins", "ratchet.js"), "// adapter\n");

  const status = ratchet(dir, ["status"], undefined, { HOME: home });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /opencode\s+user\s+.*ratchet\.js\s+\(detected\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("e2e: ratchet hook drives the normalized lifecycle", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start", "--force",
    "--role", "coder",
    "--goal", "hook failing",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(1)"',
  ]);
  assert.equal(start.status, 0, start.stderr);

  const hook = (payload) => ratchet(dir, ["hook"], JSON.stringify(payload));
  const lifecycle = (type, extra = {}) => ({ type, harness: "test", session_id: "s-1", cwd: dir, ...extra });

  const stop = hook(lifecycle("turn.stop"));
  assert.equal(stop.status, 2, stop.stderr);
  assert.equal(JSON.parse(stop.stdout).allow, false);
  assert.match(stop.stderr, /checks failed/);

  const before = hook(lifecycle("tool.before", { tool: "write", input: { path: "lib/x.ts" } }));
  assert.equal(before.status, 2, before.stderr);
  assert.equal(JSON.parse(before.stdout).allow, false);

  const prompt = hook(lifecycle("prompt.submit", { prompt: "keep going" }));
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(JSON.parse(prompt.stdout).context, /## Task contract/);

  const after = hook(lifecycle("tool.after", { tool: "write", input: { path: "src/a.ts" }, result: { exit: 0 } }));
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).continue, true);

  const fresh = ratchet(dir, [
    "task", "start", "--force",
    "--role", "coder",
    "--goal", "hook passing",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(fresh.status, 0, fresh.stderr);

  const allowed = hook(lifecycle("turn.stop"));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).certified, true);

  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "checks.json"), "utf8"));
  assert.equal(saved.ok, true);
});


test("e2e: comma-separated scope is split into patterns", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "comma scope",
    "--scope", "src/**,tests/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(start.status, 0, start.stderr);
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const contract = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
  assert.deepEqual(contract.scope, ["src/**", "tests/**"]);
});

test("e2e: done refuses a changed path outside scope", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "scope audit",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(ratchet(dir, ["check"]).status, 0);

  fs.writeFileSync(path.join(dir, "outside.txt"), "x\n");
  const refused = ratchet(dir, ["done"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /outside scope/);
  assert.match(refused.stderr, /outside\.txt/);

  fs.rmSync(path.join(dir, "outside.txt"));
  assert.equal(ratchet(dir, ["done"]).status, 0);
});

test("e2e: abandon --run closes a stranded run", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = (goal) =>
    ratchet(dir, [
      "task", "start", "--force",
      "--role", "coder",
      "--goal", goal,
      "--scope", "src/**",
      "--verify", 'node -e "process.exit(0)"',
    ]);
  assert.equal(start("first").status, 0);
  assert.equal(start("second").status, 0);
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();

  const closed = ratchet(dir, ["abandon", "--run", id, "--reason", "stranded"]);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);
  const result = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "result.json"), "utf8"));
  assert.equal(result.verdict, "abandoned");

  const again = ratchet(dir, ["abandon", "--run", id, "--reason", "again"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already closed/);
});

test("e2e: approve records a hard-rule approval and done reports it", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "force push",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(start.status, 0, start.stderr);

  const hook = (command) =>
    ratchet(
      dir,
      ["hook"],
      JSON.stringify({ type: "tool.before", harness: "test", session_id: "s1", tool: "bash", input: { command }, cwd: dir }),
    );

  const denied = hook("git push --force origin main");
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /ratchet approve --rule force-push/);

  const bad = ratchet(dir, ["approve", "--rule", "sudo", "--reason", "nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot be approved/);

  const approved = ratchet(dir, ["approve", "--rule", "force-push", "--reason", "fresh public history"]);
  assert.equal(approved.status, 0, approved.stderr);

  const allowed = hook("git push --force origin main");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).allow, true);

  assert.equal(ratchet(dir, ["check"]).status, 0);
  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /approved: force-push \(fresh public history\)/);
});

test("e2e: a space-separated scope is rejected with guidance", () => {
  const dir = session();
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const start = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "space scope",
    "--scope", "src/** tests/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /one glob per flag/);
  assert.match(start.stderr, /commas/);
});
