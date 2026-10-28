import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContract, saveContract } from "../lib/contract.mjs";
import { decide, record } from "../lib/decide.mjs";
import { readJsonl } from "../lib/fsx.mjs";

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

test("decide: read-only bash is allowed without a contract", (t) => {
  const root = emptyRepo(t);
  const decision = decide(root, event("bash", { command: "git status --porcelain" }));
  assert.equal(decision.allow, true);
  assert.equal(decision.op, "read");
});

test("decide: mutating bash is denied without a contract", (t) => {
  const root = emptyRepo(t);
  const decision = decide(root, event("bash", { command: "rm -rf src" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /No active task contract/);
});

test("decide: ratchet task start is allowed without a contract", (t) => {
  const root = emptyRepo(t);
  const decision = decide(root, event("bash", { command: 'cd repo && ratchet task start --goal "y"' }));
  assert.equal(decision.allow, true);
  assert.match(decision.reason, /contract bootstrap/);
});

test("decide: record keeps a decision made without a contract", (t) => {
  const root = emptyRepo(t);
  const input = { command: "rm -rf src" };
  const decision = decide(root, event("bash", input));
  record(root, { ...event("bash", input), harness: "test" }, decision);
  const rows = readJsonl(path.join(root, ".ratchet", "events.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "deny");
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

test("decide: deny list matches case variants", (t) => {
  const root = emptyRepo(t);
  const contract = createContract(root, {
    goal: "case",
    role: "coder",
    scope: ["**"],
    deny: [".env", ".git/**"],
  });
  saveContract(root, contract);

  for (const target of [".ENV", ".Git/config"]) {
    const decision = decide(root, event("write", { path: target }));
    assert.equal(decision.allow, false, target);
    assert.match(decision.reason, /denied/, target);
  }
  assert.equal(decide(root, event("write", { path: "src/a.ts" })).allow, true);
});

test("decide: a symlink cannot escape the scope", (t) => {
  const { root } = repo(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "src", "out"));

  const decision = decide(root, event("write", { path: "src/out/leak.txt" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("decide: a symlink inside the scope still works", (t) => {
  const { root } = repo(t);
  fs.mkdirSync(path.join(root, "src", "real"), { recursive: true });
  fs.symlinkSync(path.join(root, "src", "real"), path.join(root, "src", "link"));

  const decision = decide(root, event("write", { path: "src/link/a.ts" }));
  assert.equal(decision.allow, true);
  assert.deepEqual(decision.paths, ["src/real/a.ts"]);
});

test("decide: each session uses its own scope", (t) => {
  const root = emptyRepo(t);
  const a = createContract(root, { goal: "session a", role: "coder", scope: ["src/**"] });
  a.session_id = "A";
  saveContract(root, a);
  const b = createContract(root, { goal: "session b", role: "coder", scope: ["lib/**"] });
  b.session_id = "B";
  saveContract(root, b);

  const write = (session_id, target) =>
    decide(root, { harness: "test", session_id, tool: "write", input: { path: target } });
  assert.equal(write("A", "src/a.ts").allow, true);
  assert.equal(write("A", "lib/a.ts").allow, false);
  assert.equal(write("B", "lib/a.ts").allow, true);
  assert.equal(write("B", "src/a.ts").allow, false);
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

test("decide: inline interpreter writes are denied", (t) => {
  const { root } = repo(t);
  for (const command of [
    'python3 -c "import shutil; shutil.rmtree(\'src\')"',
    'node -e "require(\'fs\').writeFileSync(\'../outside.txt\', \'x\')"',
    'ruby -e "File.write(\'x\', \'y\')"',
    'perl -e "unlink q(x)"',
  ]) {
    const decision = decide(root, event("bash", { command }));
    assert.equal(decision.allow, false, command);
    assert.match(decision.reason, /Inline interpreter code/, command);
  }
});

test("decide: a script file inside the scope still runs", (t) => {
  const { root } = repo(t);
  const decision = decide(root, event("bash", { command: "python3 tools/build.py" }));
  assert.equal(decision.allow, true);
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

test("decide: the gate artifact is writable before the gate opens", (t) => {
  const root = emptyRepo(t);
  const contract = createContract(root, {
    goal: "bend",
    role: "coder",
    scope: ["**/*.bend", "LAWS.bend", "PROOF.bend"],
    gates: [{ artifact: "LAWS.bend", before: ["**/*.bend"], message: "write the law first" }],
  });
  saveContract(root, contract);

  assert.equal(decide(root, event("write", { path: "LAWS.bend" })).allow, true);
  assert.equal(decide(root, event("write", { path: "PROOF.bend" })).allow, false);
  assert.equal(decide(root, event("write", { path: "code.bend" })).allow, false);

  fs.writeFileSync(path.join(root, "LAWS.bend"), "law x\n");
  assert.equal(decide(root, event("write", { path: "code.bend" })).allow, true);
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
