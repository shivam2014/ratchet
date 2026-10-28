import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { eventsPath } from "../lib/contract.mjs";
import { readJsonl } from "../lib/fsx.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const ADAPTER = path.join(import.meta.dirname, "..", "adapters", "pi", "ratchet.ts");
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.error(\'boom\'); process.exit(1)"';

const loaded = await import(pathToFileURL(ADAPTER).href).then(
  (module) => ({ adapter: module.default }),
  (error) => ({ error }),
);
const skipped = loaded.error
  ? `pi adapter cannot be imported under Node ${process.version}: ${loaded.error.message}`
  : false;

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-pi-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-pi-bin-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "pi-adapter", private: true, scripts: { check: PASS } }, null, 2),
  );

  // spawnSync takes no argv array for the binary, so RATCHET_BIN points at a shim.
  const shim = path.join(bin, "ratchet");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  process.env.RATCHET_BIN = shim;
  return dir;
}

function ratchet(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

function start(dir, goal, verify = PASS) {
  const result = ratchet(dir, ["task", "start", "--force", "--role", "coder", "--goal", goal, "--scope", "src/**", "--verify", verify]);
  assert.equal(result.status, 0, result.stderr);
}

function rows(dir) {
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  return readJsonl(eventsPath(dir, id));
}

/** A pi ExtensionAPI that records handlers and sent messages. */
function harness(dir) {
  const handlers = new Map();
  const messages = [];
  loaded.adapter({
    on(name, handler) {
      handlers.set(name, handler);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  });
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "pi-session-1" } };
  return {
    messages,
    async fire(name, event) {
      const handler = handlers.get(name);
      assert.ok(handler, `${name} handler registered`);
      return handler({ type: name, ...event }, ctx);
    },
  };
}

const assistant = (text) => [{ role: "assistant", content: [{ type: "text", text }] }];

test("pi adapter: prompt creates an auto contract and appends the brief", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const pi = harness(dir);

  const result = await pi.fire("before_agent_start", {
    messageType: "user",
    prompt: "add the parser",
    systemPrompt: "BASE PROMPT",
  });
  assert.match(result.systemPrompt, /^BASE PROMPT\n\n## Task contract/);
  assert.match(result.systemPrompt, /Write scope: \*\*/);

  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  const contract = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
  assert.equal(contract.auto, true);
  assert.equal(contract.harness, "pi");
  assert.equal(contract.session_id, "pi-session-1");

  const promptRows = rows(dir).filter((row) => row.type === "prompt.submit");
  assert.equal(promptRows.length, 1);
  assert.match(promptRows[0].prompt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(promptRows).includes("add the parser"), false);

  const repeated = await pi.fire("before_agent_start", {
    messageType: "user",
    prompt: "another turn",
    systemPrompt: result.systemPrompt,
  });
  assert.equal(repeated, undefined, "an already appended brief is not duplicated");

  const custom = await pi.fire("before_agent_start", {
    messageType: "custom",
    message: { role: "custom", customType: "ratchet", content: "stop", display: true },
    systemPrompt: "BASE PROMPT",
  });
  assert.equal(custom, undefined, "custom runs do not resubmit a prompt");
});

test("pi adapter: tool_call blocks outside scope and stays silent on allow or read", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "guard task");
  const pi = harness(dir);

  const deny = await pi.fire("tool_call", {
    toolName: "write",
    toolCallId: "call-1",
    input: { path: "outside.txt", content: "leak" },
  });
  assert.equal(deny.block, true);
  assert.match(deny.reason, /outside scope/);

  const allow = await pi.fire("tool_call", {
    toolName: "write",
    toolCallId: "call-2",
    input: { path: "src/a.ts", content: "ok" },
  });
  assert.equal(allow, undefined);

  const read = await pi.fire("tool_call", { toolName: "read", toolCallId: "call-3", input: { path: "README.md" } });
  assert.equal(read, undefined);

  assert.deepEqual(
    rows(dir).map((row) => [row.tool, row.op, row.decision, row.harness]),
    [
      ["write", "write", "deny", "pi"],
      ["write", "write", "allow", "pi"],
    ],
  );
});

test("pi adapter: tool_result sends post-check context to the model", { skip: skipped }, async (t) => {
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

  const pi = harness(dir);
  const result = await pi.fire("tool_result", {
    toolName: "write",
    toolCallId: "call-4",
    input: { path: "src/a.ts", content: "export const a = 1\n" },
    content: [{ type: "text", text: "wrote src/a.ts" }],
    isError: false,
  });
  assert.equal(result, undefined);
  assert.equal(pi.messages.length, 1);

  const [{ message, options }] = pi.messages;
  assert.equal(message.customType, "ratchet");
  assert.equal(message.display, true);
  assert.match(message.content, /post checks failed: lint/);
  assert.match(message.content, /lint failed: src\/a\.ts/);
  assert.equal(options.triggerTurn, true);

  const row = rows(dir).find((entry) => entry.type === "tool.after");
  assert.equal(row.harness, "pi");
  assert.equal(row.tool, "write");
  assert.equal(row.decision, "observed");
  assert.equal(row.ok, true);
});

test("pi adapter: Stop blocks a failing verify and stays silent on a passing one", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir, "failing task", FAIL);

  const pi = harness(dir);
  await pi.fire("agent_end", { messages: assistant("all done") });
  assert.equal(pi.messages.length, 1);
  const { message, options } = pi.messages[0];
  assert.equal(message.customType, "ratchet");
  assert.equal(message.display, true);
  assert.match(message.content, /checks failed/);
  assert.match(message.content, /boom/);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });

  const blocked = rows(dir).find((entry) => entry.type === "turn.stop");
  assert.equal(blocked.decision, "block");
  assert.equal(blocked.certified, false);
  assert.match(blocked.last_message_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(blocked).includes("all done"), false);

  start(dir, "passing task", PASS);
  await pi.fire("agent_end", { messages: assistant("done") });
  assert.equal(pi.messages.length, 1, "a passing verify sends no message");

  const certified = rows(dir).find((entry) => entry.type === "turn.stop");
  assert.equal(certified.decision, "allow");
  assert.equal(certified.certified, true);
});

test("pi adapter: every lifecycle event no-ops outside a Ratchet repo", { skip: skipped }, async (t) => {
  const dir = repo(t);
  const pi = harness(dir);

  assert.equal(
    await pi.fire("before_agent_start", { messageType: "user", prompt: "hello", systemPrompt: "BASE" }),
    undefined,
  );
  assert.equal(await pi.fire("tool_call", { toolName: "write", input: { path: "x.txt" } }), undefined);
  assert.equal(
    await pi.fire("tool_result", { toolName: "write", input: { path: "x.txt" }, content: [], isError: false }),
    undefined,
  );
  assert.equal(await pi.fire("agent_end", { messages: [] }), undefined);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet")), false);
  assert.equal(pi.messages.length, 0);
});
