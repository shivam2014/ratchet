import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContract, saveContract } from "../lib/contract.mjs";
import { decide, record } from "../lib/decide.mjs";

function emptyRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-decide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repo(t, opts = {}) {
  const root = emptyRepo(t);
  const contract = createContract(root, {
    goal: "unit test",
    role: "coder",
    scope: ["src/**"],
    deny: [".env"],
    maxFiles: 2,
    maxWrites: 2,
    ...opts,
  });
  saveContract(root, contract);
  return { root, contract };
}

const event = (tool, input, cwd) => ({ tool, input, cwd });

test("decide: reads are allowed without a contract", (t) => {
  const root = emptyRepo(t);
  const decision = decide(root, event("read", { path: "src/a.ts" }));
  assert.equal(decision.allow, true);
});

test("decide: writes are denied without a contract", (t) => {
  const root = emptyRepo(t);
  const decision = decide(root, event("write", { path: "src/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /No active task contract/);
});

test("decide: write inside scope is allowed", (t) => {
  const { root } = repo(t);
  const decision = decide(root, event("write", { path: "src/a.ts" }));
  assert.equal(decision.allow, true);
  assert.deepEqual(decision.paths, ["src/a.ts"]);
});

test("decide: write outside scope is denied", (t) => {
  const { root } = repo(t);
  const decision = decide(root, event("write", { path: "lib/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("decide: deny list wins over scope", (t) => {
  const { root } = repo(t, { deny: ["src/secret/**"] });
  const decision = decide(root, event("write", { path: "src/secret/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /denied/);
});

test("decide: read-only contract blocks writes", (t) => {
  const { root } = repo(t, { readOnly: true });
  const decision = decide(root, event("write", { path: "src/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /read-only/);
});

test("decide: write with no path is denied", (t) => {
  const { root } = repo(t);
  const decision = decide(root, event("write", { content: "x" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /Cannot resolve a write target/);
});

test("decide: bash hard deny", (t) => {
  const { root } = repo(t);
  const decision = decide(root, event("bash", { command: "rm -rf /" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /hard rule/);
});

test("decide: bash redirect outside scope is denied", (t) => {
  const { root } = repo(t);
  const decision = decide(root, event("bash", { command: "echo x > lib/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("decide: unresolved bash mutation is allowed and marked", (t) => {
  const { root } = repo(t);
  const decision = decide(root, event("bash", { command: "npm install" }));
  assert.equal(decision.allow, true);
  assert.equal(decision.unresolved, true);
});

test("decide: skill gate denies source writes until the artifact exists", (t) => {
  const root = emptyRepo(t);
  const contract = createContract(root, {
    goal: "gate",
    role: "coder",
    scope: ["src/**", ".ratchet/plan.md"],
    gates: [{ artifact: ".ratchet/plan.md", before: ["src/**"], message: "write the plan first" }],
  });
  saveContract(root, contract);

  const denied = decide(root, event("write", { path: "src/a.ts" }));
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /write the plan first/);

  const artifact = decide(root, event("write", { path: ".ratchet/plan.md" }));
  assert.equal(artifact.allow, true);

  fs.mkdirSync(path.join(root, ".ratchet"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ratchet", "plan.md"), "# Plan\n1. step\n");
  const allowed = decide(root, event("write", { path: "src/a.ts" }));
  assert.equal(allowed.allow, true);
});

test("decide: file budget blocks a new path", (t) => {
  const { root, contract } = repo(t, { maxFiles: 1 });
  record(root, event("write", { path: "src/a.ts" }), {
    allow: true,
    op: "write",
    paths: ["src/a.ts"],
    runId: contract.id,
  });
  const decision = decide(root, event("write", { path: "src/b.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /budget/i);
});

test("decide: write budget blocks a repeat write", (t) => {
  const { root, contract } = repo(t, { maxFiles: 10, maxWrites: 1 });
  record(root, event("write", { path: "src/a.ts" }), {
    allow: true,
    op: "write",
    paths: ["src/a.ts"],
    runId: contract.id,
  });
  const decision = decide(root, event("write", { path: "src/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /budget/i);
});
