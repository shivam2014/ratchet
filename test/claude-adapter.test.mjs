import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { eventsPath } from "../lib/contract.mjs";
import { readJsonl } from "../lib/fsx.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const ADAPTER = path.join(import.meta.dirname, "..", "adapters", "claude", "hook.mjs");
const LIFECYCLE = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const PASS = 'node -e "process.exit(0)"';

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "claude-adapter", private: true, scripts: { check: PASS } }, null, 2),
  );
  return dir;
}

function ratchet(dir, args, input, env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** One real Claude Code hook payload. */
function claude(dir, payload) {
  return spawnSync(process.execPath, [ADAPTER], {
    cwd: dir,
    input: JSON.stringify({
      session_id: "session-1",
      transcript_path: path.join(dir, "transcript.jsonl"),
      cwd: dir,
      permission_mode: "default",
      ...payload,
    }),
    encoding: "utf8",
  });
}

function rows(dir) {
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  return readJsonl(eventsPath(dir, id));
}

function start(dir, goal, verify = PASS) {
  const result = ratchet(dir, ["task", "start", "--force", "--role", "coder", "--goal", goal, "--scope", "src/**", "--verify", verify]);
  assert.equal(result.status, 0, result.stderr);
}

test("claude adapter: UserPromptSubmit injects the active contract brief", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "adapter task");

  const result = claude(dir, { hook_event_name: "UserPromptSubmit", prompt: "add the parser" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /## Task contract/);
  assert.match(output.hookSpecificOutput.additionalContext, /Goal: adapter task/);
  assert.match(output.hookSpecificOutput.additionalContext, /Write scope: src\/\*\*/);

  const promptRows = rows(dir).filter((row) => row.type === "prompt.submit");
  assert.equal(promptRows.length, 1);
  assert.equal(promptRows[0].harness, "claude");
  assert.equal(promptRows[0].session_id, "session-1");
  assert.match(promptRows[0].prompt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(promptRows).includes("add the parser"), false);
});

test("claude adapter: UserPromptSubmit creates an auto contract when none exists", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);

  const pre = claude(dir, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x.txt" } });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout.trim(), "");

  const result = claude(dir, { hook_event_name: "UserPromptSubmit", prompt: "add a parser" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /## Task contract/);

  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const contract = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
  assert.equal(contract.auto, true);
  assert.equal(contract.harness, "claude");
  assert.equal(contract.session_id, "session-1");
});

test("claude adapter: PreToolUse denies outside scope and is silent on allow", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "guard task");

  const deny = claude(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "outside.txt", content: "leak" },
    tool_use_id: "toolu_01",
  });
  assert.equal(deny.status, 0, deny.stderr);
  const denied = JSON.parse(deny.stdout);
  assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /outside scope/);

  const allow = claude(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts", content: "ok" },
    tool_use_id: "toolu_02",
  });
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(allow.stdout.trim(), "");

  const trail = rows(dir);
  assert.deepEqual(
    trail.map((row) => [row.tool, row.op, row.decision, row.harness]),
    [
      ["Write", "write", "deny", "claude"],
      ["Write", "write", "allow", "claude"],
    ],
  );
});

test("claude adapter: PostToolUse records the result without blocking", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "observe task");

  const result = claude(dir, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts", content: "ok" },
    tool_response: { filePath: "src/a.ts", success: true },
    tool_use_id: "toolu_03",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");

  const row = rows(dir).find((entry) => entry.type === "tool.after");
  assert.equal(row.harness, "claude");
  assert.equal(row.tool, "Write");
  assert.equal(row.decision, "observed");
  assert.equal(row.ok, true);
});

test("claude adapter: PostToolUse returns failing post-check context", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "post task");
  const configFile = path.join(dir, ".ratchet", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.post = [{ id: "lint", cmd: "node lint.mjs {files}" }];
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, "lint.mjs"), 'console.error("lint failed: " + process.argv.slice(2).join(" "));\nprocess.exit(1);\n');
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1\n");

  const result = claude(dir, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts", content: "export const a = 1\n" },
    tool_response: { filePath: "src/a.ts", success: true },
    tool_use_id: "toolu_06",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /post checks failed: lint/);
  assert.match(output.hookSpecificOutput.additionalContext, /lint failed: src\/a\.ts/);
});

test("claude adapter: Stop blocks a failing verify and allows a passing one", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "failing task", 'node -e "console.error(\'boom\'); process.exit(1)"');

  const blocked = claude(dir, {
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "all done",
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /checks failed/);
  assert.match(decision.reason, /boom/);

  const row = rows(dir).find((entry) => entry.type === "turn.stop");
  assert.equal(row.decision, "block");
  assert.equal(row.certified, false);
  assert.match(row.last_message_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(row).includes("all done"), false);

  start(dir, "passing task", PASS);
  const allowed = claude(dir, { hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "done" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");

  const certified = rows(dir).find((entry) => entry.type === "turn.stop");
  assert.equal(certified.decision, "allow");
  assert.equal(certified.certified, true);
});

test("claude adapter: every lifecycle event no-ops outside a contract", (t) => {
  const dir = repo(t);
  const payloads = [
    { hook_event_name: "UserPromptSubmit", prompt: "hello" },
    { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x.txt" } },
    { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "x.txt" }, tool_response: {} },
    { hook_event_name: "Stop", stop_hook_active: false },
  ];
  for (const payload of payloads) {
    const result = claude(dir, payload);
    assert.equal(result.status, 0, `${payload.hook_event_name}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "", payload.hook_event_name);
  }
});

test("install: claude lifecycle hooks are idempotent and removable", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const settingsFile = path.join(dir, ".claude/settings.json");
  const userSettings = {
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-pre" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
    },
  };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2));

  const install = () => ratchet(dir, ["install", "--harness", "claude", "--project", "--yes"]);
  const handlersFor = (settings, event) =>
    (settings.hooks?.[event] ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .filter((handler) => typeof handler.command === "string" && handler.command.includes("ratchet"));

  assert.equal(install().status, 0);
  const first = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(first.permissions, userSettings.permissions);
  assert.deepEqual(first.hooks.PreToolUse[0], userSettings.hooks.PreToolUse[0]);
  assert.deepEqual(first.hooks.Stop[0], userSettings.hooks.Stop[0]);

  const expected = `${process.execPath} ${ADAPTER}`;
  for (const event of LIFECYCLE) {
    const handlers = handlersFor(first, event);
    assert.equal(handlers.length, 1, `${event} has one ratchet handler`);
    assert.equal(handlers[0].command, expected);
  }
  assert.equal(handlersFor(first, "Stop")[0].timeout, 600);

  assert.equal(install().status, 0);
  const second = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(second, first);

  const backups = fs
    .readdirSync(path.dirname(settingsFile))
    .filter((name) => name.startsWith("settings.json.ratchet.bak."));
  assert.ok(backups.length >= 1, "install backs up the original settings");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(settingsFile), backups[0]), "utf8")), userSettings);

  assert.equal(ratchet(dir, ["uninstall", "--harness", "claude", "--project"]).status, 0);
  const removed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(removed.permissions, userSettings.permissions);
  assert.deepEqual(removed.hooks.PreToolUse, userSettings.hooks.PreToolUse);
  assert.deepEqual(removed.hooks.Stop, userSettings.hooks.Stop);
  for (const event of LIFECYCLE) assert.equal(handlersFor(removed, event).length, 0, event);

  const after = fs.readFileSync(settingsFile, "utf8");
  assert.equal(ratchet(dir, ["uninstall", "--harness", "claude", "--project"]).status, 0);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), after);
});

test("install: claude dry run plans the hooks and writes nothing", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const settingsFile = path.join(dir, ".claude/settings.json");

  const dry = ratchet(dir, ["install", "--harness", "claude", "--project", "--yes", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /create .*\.claude\/settings\.json/);
  assert.match(dry.stdout, /dry run: nothing written/);
  assert.equal(fs.existsSync(settingsFile), false);

  assert.equal(ratchet(dir, ["install", "--harness", "claude", "--project", "--yes"]).status, 0);
  const written = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  for (const event of LIFECYCLE) assert.equal(written.hooks[event].length, 1, event);
});

test("doctor: verifies every claude lifecycle hook", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(ratchet(dir, ["install", "--harness", "claude", "--project", "--yes"]).status, 0);
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, ".claude") };

  const ok = ratchet(dir, ["doctor", "--harness", "claude"], undefined, env);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  for (const event of LIFECYCLE) assert.match(ok.stdout, new RegExp(`PASS\\s+claude ${event} hook`));

  const settingsFile = path.join(dir, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  settings.hooks.Stop = [];
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  const broken = ratchet(dir, ["doctor", "--harness", "claude"], undefined, env);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /FAIL\s+claude Stop hook/);
});
