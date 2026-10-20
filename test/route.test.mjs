import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { routePrompt } from "../lib/route.mjs";
import { defaultConfig, saveConfig } from "../lib/contract.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function repo(t, auto = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveConfig(root, {
    ...defaultConfig(root),
    checks: [{ id: "check", cmd: 'node -e "process.exit(0)"' }],
    auto: { enabled: true, ...auto },
  });
  return root;
}

function prompt(root, text = "build a thing", session = "s-1") {
  return {
    type: "prompt.submit",
    harness: "test",
    session_id: session,
    prompt: text,
    cwd: root,
  };
}

function run(root, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
  });
}

test("route: auto creates one contract and hashes the prompt", (t) => {
  const root = repo(t);
  const text = "build a thing with a secret prompt";
  const routed = routePrompt(root, prompt(root, text));

  assert.equal(routed.created, true);
  assert.equal(routed.contract.auto, true);
  assert.equal(routed.contract.harness, "test");
  assert.equal(routed.contract.session_id, "s-1");
  assert.deepEqual(routed.contract.scope, ["**"]);
  assert.equal(routed.contract.verify[0].cmd, 'node -e "process.exit(0)"');
  assert.match(routed.contract.goal, /^auto task [a-f0-9]{8}$/);

  const route = JSON.parse(fs.readFileSync(path.join(root, ".ratchet", "runs", routed.contract.id, "route.json"), "utf8"));
  assert.equal(route.decision, "default");
  assert.equal(route.prompt_length, text.length);
  assert.match(route.prompt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(route).includes(text), false);
  assert.equal(fs.readFileSync(path.join(root, ".ratchet", "runs", routed.contract.id, "contract.json"), "utf8").includes(text), false);
});

test("route: the created contract locks the check surface", (t) => {
  const root = repo(t);
  saveConfig(root, {
    ...defaultConfig(root),
    checks: [{ id: "check", cmd: "node check.mjs" }],
    auto: { enabled: true },
  });
  fs.writeFileSync(path.join(root, "check.mjs"), "process.exit(0)\n");

  const routed = routePrompt(root, prompt(root));
  const lock = routed.contract.checksLock;

  assert.match(lock.config, /^[a-f0-9]{64}$/);
  assert.match(lock.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(lock.files), ["check.mjs"]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, ".ratchet", "runs", routed.contract.id, "contract.json"), "utf8"));
  assert.deepEqual(saved.checksLock, lock);
});

test("route: a second prompt reuses the active contract", (t) => {
  const root = repo(t);
  const first = routePrompt(root, prompt(root, "first", "s-1"));
  const second = routePrompt(root, prompt(root, "second", "s-2"));
  assert.equal(second.created, false);
  assert.equal(second.contract.id, first.contract.id);
});

test("route: auto disabled leaves the manual flow alone", (t) => {
  const root = repo(t, { enabled: false });
  const routed = routePrompt(root, prompt(root));
  assert.equal(routed.created, false);
  assert.equal(routed.contract, null);
  assert.equal(fs.existsSync(path.join(root, ".ratchet", "current")), false);
});

test("route: empty prompt does not create a contract", (t) => {
  const root = repo(t);
  const routed = routePrompt(root, prompt(root, "   "));
  assert.equal(routed.created, false);
  assert.equal(routed.contract, null);
});

test("route: prompt.submit hook creates the contract and injects the brief", (t) => {
  const root = repo(t);
  const result = run(root, ["hook"], JSON.stringify(prompt(root, "build flappy")));
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.created, true);
  assert.match(decision.context, /Task contract/);
  assert.match(decision.context, /Write scope: \*\*/);

  const id = fs.readFileSync(path.join(root, ".ratchet", "current"), "utf8").trim();
  assert.equal(decision.run, id);
  const events = fs.readFileSync(path.join(root, ".ratchet", "runs", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("build flappy"), false);
  assert.match(events, /prompt_sha256/);

  const allowed = run(root, ["hook"], JSON.stringify({
    type: "tool.before",
    harness: "test",
    session_id: "s-1",
    tool: "write",
    input: { path: "src/a.ts" },
    cwd: root,
  }));
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("route: prompt.submit without auto config is a silent no-op", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-route-manual-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = defaultConfig(root);
  delete config.auto;
  saveConfig(root, config);
  const result = run(root, ["hook"], JSON.stringify(prompt(root)));
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.context, null);
  assert.equal(decision.created, false);
  assert.equal(fs.existsSync(path.join(root, ".ratchet", "current")), false);
});
