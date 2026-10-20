import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { eventsPath } from "../lib/contract.mjs";
import { readJsonl } from "../lib/fsx.mjs";
import { findRatchetHooks, hookTrustHash, readTrustHash } from "../lib/codex-trust.mjs";
import { mergeCodexHooks, removeCodexHooks } from "../lib/harnesses.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const ADAPTER = path.join(import.meta.dirname, "..", "adapters", "codex", "hook.mjs");
const LIFECYCLE = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const PASS = 'node -e "process.exit(0)"';
const PATCH = (file) => `*** Begin Patch\n*** Add File: ${file}\n+leak\n*** End Patch`;

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-codex-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "codex-adapter", private: true, scripts: { check: PASS } }, null, 2),
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

/** One real Codex CLI hook payload. */
function codex(dir, payload) {
  return spawnSync(process.execPath, [ADAPTER], {
    cwd: dir,
    input: JSON.stringify({
      session_id: "codex-session-1",
      transcript_path: path.join(dir, "transcript.jsonl"),
      cwd: dir,
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
  const result = ratchet(dir, ["task", "start", "--role", "coder", "--goal", goal, "--scope", "src/**", "--verify", verify]);
  assert.equal(result.status, 0, result.stderr);
}

test("codex adapter: UserPromptSubmit injects the active contract brief", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "adapter task");

  const result = codex(dir, { hook_event_name: "UserPromptSubmit", prompt: "add the parser" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /## Task contract/);
  assert.match(output.hookSpecificOutput.additionalContext, /Goal: adapter task/);

  const promptRows = rows(dir).filter((row) => row.type === "prompt.submit");
  assert.equal(promptRows.length, 1);
  assert.equal(promptRows[0].harness, "codex");
  assert.equal(promptRows[0].session_id, "codex-session-1");
  assert.match(promptRows[0].prompt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(promptRows).includes("add the parser"), false);
});

test("codex adapter: UserPromptSubmit creates an auto contract when none exists", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);

  const pre = codex(dir, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x.txt" } });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout.trim(), "");

  const result = codex(dir, { hook_event_name: "UserPromptSubmit", prompt: "add a parser" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /## Task contract/);

  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const contract = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
  assert.equal(contract.auto, true);
  assert.equal(contract.harness, "codex");
  assert.equal(contract.session_id, "codex-session-1");
});

test("codex adapter: PreToolUse maps Bash, apply_patch, and Write", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "guard task");

  const patch = codex(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: PATCH("outside.txt") },
    tool_use_id: "call-1",
  });
  assert.equal(patch.status, 0, patch.stderr);
  const denied = JSON.parse(patch.stdout);
  assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /outside scope/);

  const write = codex(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts", content: "ok" },
    tool_use_id: "call-2",
  });
  assert.equal(write.status, 0, write.stderr);
  assert.equal(write.stdout.trim(), "");

  const bash = codex(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "touch outside.txt" },
    tool_use_id: "call-3",
  });
  assert.equal(bash.status, 0, bash.stderr);
  assert.equal(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecision, "deny");

  assert.deepEqual(
    rows(dir).map((row) => [row.tool, row.op, row.decision, row.harness]),
    [
      ["write", "write", "deny", "codex"],
      ["write", "write", "allow", "codex"],
      ["bash", "write", "deny", "codex"],
    ],
  );
});

test("codex adapter: PostToolUse records the result without blocking", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "observe task");

  const failed = codex(dir, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "false" },
    tool_response: { exit_code: 1, output: "boom" },
    tool_use_id: "call-4",
  });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(failed.stdout.trim(), "");

  const patched = codex(dir, {
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: { command: PATCH("src/a.ts") },
    tool_response: { success: true },
    tool_use_id: "call-5",
  });
  assert.equal(patched.status, 0, patched.stderr);
  assert.equal(patched.stdout.trim(), "");

  const trail = rows(dir).filter((row) => row.type === "tool.after");
  assert.deepEqual(
    trail.map((row) => [row.tool, row.decision, row.ok, row.exit]),
    [
      ["bash", "observed", false, 1],
      ["write", "observed", true, null],
    ],
  );
});

test("codex adapter: Stop blocks a failing verify and allows a passing one", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "failing task", 'node -e "console.error(\'boom\'); process.exit(1)"');

  const blocked = codex(dir, {
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
  const allowed = codex(dir, { hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "done" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");

  const certified = rows(dir).find((entry) => entry.type === "turn.stop");
  assert.equal(certified.decision, "allow");
  assert.equal(certified.certified, true);
});

test("codex adapter: every lifecycle event no-ops outside a Ratchet repo", (t) => {
  const dir = repo(t);
  const payloads = [
    { hook_event_name: "UserPromptSubmit", prompt: "hello" },
    { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: PATCH("x.txt") } },
    {
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: PATCH("x.txt") },
      tool_response: { success: true },
    },
    { hook_event_name: "Stop", stop_hook_active: false },
  ];
  for (const payload of payloads) {
    const result = codex(dir, payload);
    assert.equal(result.status, 0, `${payload.hook_event_name}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "", payload.hook_event_name);
  }
});

function isolatedEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { HOME: home, CODEX_HOME: path.join(home, ".codex") };
}

const userHooks = {
  theme: "dark",
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user-prompt" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-pre" }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: "echo user-post" }] }],
    Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "echo user-session" }] }],
  },
};

function handlersFor(settings, event) {
  return (settings?.hooks?.[event] ?? [])
    .flatMap((group) => group.hooks ?? [])
    .filter((handler) => typeof handler.command === "string" && handler.command.includes("adapters/codex/hook.mjs"));
}

test("mergeCodexHooks splits a mixed group and keeps unrelated handlers", () => {
  const command = `${process.execPath} ${ADAPTER}`;
  const theirs = { type: "command", command: "echo user" };
  const hooks = {
    PreToolUse: [{ matcher: "Bash", hooks: [theirs, { type: "command", command }] }],
  };

  const first = mergeCodexHooks(hooks, command);
  assert.equal(first.PreToolUse.length, 2);
  assert.equal(first.PreToolUse[0].hooks.length, 1);
  assert.equal(first.PreToolUse[0].hooks[0].command, command);
  assert.deepEqual(first.PreToolUse[1], { matcher: "Bash", hooks: [theirs] });
  assert.deepEqual(mergeCodexHooks(first, command), first);

  assert.equal(removeCodexHooks(first), true);
  assert.deepEqual(first.PreToolUse, [{ matcher: "Bash", hooks: [theirs] }]);
  assert.equal(removeCodexHooks(first), false);
});

test("install: codex lifecycle hooks are idempotent and removable", (t) => {
  const dir = repo(t);
  const env = isolatedEnv(t);
  ratchet(dir, ["init"], undefined, env);
  const hooksFile = path.join(dir, ".codex/hooks.json");
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify(userHooks, null, 2));

  const install = () => ratchet(dir, ["install", "--harness", "codex", "--project", "--yes"], undefined, env);
  const expected = `${process.execPath} ${ADAPTER}`;

  assert.equal(install().status, 0);
  const first = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(first.theme, "dark");
  for (const event of LIFECYCLE) {
    const handlers = handlersFor(first, event);
    assert.equal(handlers.length, 1, `${event} has one ratchet handler`);
    assert.equal(handlers[0].command, expected);
    const group = first.hooks[event].find((entry) => (entry.hooks ?? []).includes(handlers[0]));
    assert.equal(group.hooks.length, 1, `${event} keeps the ratchet handler in its own group`);
    assert.deepEqual(first.hooks[event][0], userHooks.hooks[event][0]);
  }
  assert.equal(handlersFor(first, "Stop")[0].timeout, 600);
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
    assert.equal(handlersFor(first, event)[0].timeout, 30);
  }
  assert.deepEqual(first.hooks.SessionStart, userHooks.hooks.SessionStart);

  const trust = findRatchetHooks(hooksFile);
  assert.deepEqual(trust.map((hook) => hook.event), LIFECYCLE);
  for (const hook of trust) {
    assert.equal(readTrustHash(env.CODEX_HOME, hook.key), hookTrustHash(hook.group, hook.handler, hook.event));
  }

  assert.equal(install().status, 0);
  const second = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.deepEqual(second, first);

  const backups = fs
    .readdirSync(path.dirname(hooksFile))
    .filter((name) => name.startsWith("hooks.json.ratchet.bak."));
  assert.ok(backups.length >= 1, "install backs up the original hooks");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(hooksFile), backups[0]), "utf8")), userHooks);

  assert.equal(ratchet(dir, ["uninstall", "--harness", "codex", "--project"], undefined, env).status, 0);
  const removed = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(removed.theme, "dark");
  assert.deepEqual(removed.hooks.SessionStart, userHooks.hooks.SessionStart);
  for (const event of LIFECYCLE) {
    assert.deepEqual(removed.hooks[event], userHooks.hooks[event], event);
  }

  const after = fs.readFileSync(hooksFile, "utf8");
  assert.equal(ratchet(dir, ["uninstall", "--harness", "codex", "--project"], undefined, env).status, 0);
  assert.equal(fs.readFileSync(hooksFile, "utf8"), after);
});

test("doctor: verifies and trusts every codex lifecycle hook", (t) => {
  const dir = repo(t);
  const env = isolatedEnv(t);
  ratchet(dir, ["init"], undefined, env);
  assert.equal(ratchet(dir, ["install", "--harness", "codex", "--project", "--yes"], undefined, env).status, 0);

  const ok = ratchet(dir, ["doctor", "--harness", "codex"], undefined, env);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  for (const event of LIFECYCLE) {
    assert.match(ok.stdout, new RegExp(`PASS\\s+codex ${event} hook`));
    assert.match(ok.stdout, new RegExp(`PASS\\s+codex ${event} trust hash`));
    assert.match(ok.stdout, new RegExp(`PASS\\s+codex ${event} no-op`));
  }

  const configFile = path.join(env.CODEX_HOME, "config.toml");
  const lines = fs.readFileSync(configFile, "utf8").split("\n");
  const last = lines.findLastIndex((line) => line.startsWith("trusted_hash"));
  lines[last] = 'trusted_hash = "sha256:deadbeef"';
  fs.writeFileSync(configFile, lines.join("\n"));

  const broken = ratchet(dir, ["doctor", "--harness", "codex"], undefined, env);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /FAIL\s+codex Stop trust hash/);
});
