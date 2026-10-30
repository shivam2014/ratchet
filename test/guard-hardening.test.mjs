import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContract, defaultConfig, saveContract } from "../lib/contract.mjs";
import { decide } from "../lib/decide.mjs";

function emptyRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-hardening-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repo(t, opts = {}) {
  const root = emptyRepo(t);
  const contract = createContract(root, {
    goal: "hardening",
    role: "coder",
    scope: ["**"],
    deny: [".env", ".git/**"],
    maxFiles: 50,
    maxWrites: 50,
    ...opts,
  });
  saveContract(root, contract);
  return root;
}

const ev = (tool, input) => ({ tool, input });

// --- repo containment -------------------------------------------------------

test("hardening: an absolute target outside the repo is denied under ** scope", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("write", { path: "/etc/passwd" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: an absolute target in a sibling temp dir is denied", (t) => {
  const root = repo(t);
  const outside = fs.mkdtempSync("/var/tmp/ratchet-sibling-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const decision = decide(root, ev("write", { path: path.join(outside, "leak.txt") }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: a relative escape is still denied", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("write", { path: "src/../outside.txt" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

// --- guard state ------------------------------------------------------------

test("hardening: .ratchet/disabled.json cannot be written by a task", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("write", { path: ".ratchet/disabled.json" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /guard state/);
});

test("hardening: .ratchet/current cannot be written by a task", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("write", { path: ".ratchet/current" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /guard state/);
});

test("hardening: a contract file cannot be rewritten by a task", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("write", { path: ".ratchet/runs/abc/contract.json" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /guard state/);
});

test("hardening: .ratchet/config.json cannot be written by a task", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("write", { path: ".ratchet/config.json" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /guard state/);
});

test("hardening: a gate artifact under .ratchet stays writable", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("write", { path: ".ratchet/plan.md" }));
  assert.equal(decision.allow, true);
});

// --- shell wrappers ---------------------------------------------------------

test("hardening: bash -c rm outside scope is denied", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "bash -c 'rm lib/a.ts'" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: bash -lc rm outside scope is denied", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "bash -lc 'rm lib/a.ts'" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: env prefix rm outside scope is denied", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "env rm lib/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: bash -c redirect outside scope is denied", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "bash -c 'echo x > lib/a.ts'" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: bash -c write inside scope is allowed", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "bash -c 'echo x > src/a.ts'" }));
  assert.equal(decision.allow, true);
});

// --- guard CLI and git hooks ------------------------------------------------

test("hardening: ratchet disable is denied", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "ratchet disable --reason x" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /hard rule/);
});

test("hardening: ratchet uninstall is denied", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "ratchet uninstall --harness opencode --user" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /hard rule/);
});

test("hardening: git commit --no-verify is denied", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "git commit --no-verify -m x" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /hard rule/);
});

test("hardening: git config core.hooksPath is denied", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "git config core.hooksPath /tmp" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /hard rule/);
});

test("hardening: ratchet enable is still allowed", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "ratchet enable" }));
  assert.equal(decision.allow, true);
});

// --- read-only contracts ----------------------------------------------------

test("hardening: a read-only contract blocks bash mutations", (t) => {
  const root = repo(t, { readOnly: true });
  const decision = decide(root, ev("bash", { command: "echo pwn > src/x.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /read-only/);
});

test("hardening: a read-only contract blocks unresolved bash mutations", (t) => {
  const root = repo(t, { readOnly: true });
  const decision = decide(root, ev("bash", { command: "npm install" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /read-only/);
});

// --- contract replacement ---------------------------------------------------

test("hardening: task start is left to the CLI's live-contract refusal", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "ratchet task start --role coder --goal widen --scope **" }));
  assert.equal(decision.allow, true);
  assert.equal(decision.hardDeny, undefined);
});

test("hardening: a task cannot re-init the repo config", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "ratchet init --force" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /hard rule/);
});

// --- default deny depth -----------------------------------------------------

test("hardening: nested src/.env is denied by the default deny list", (t) => {
  const root = emptyRepo(t);
  const cfg = defaultConfig(root);
  const contract = createContract(root, {
    goal: "defaults",
    role: "coder",
    scope: ["src/**"],
    deny: cfg.defaults.deny,
    maxFiles: 50,
    maxWrites: 50,
  });
  saveContract(root, contract);
  const decision = decide(root, ev("write", { path: "src/.env" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /denied/);
});

// --- patch parsing ----------------------------------------------------------

test("hardening: apply_patch Move to an out-of-scope path is denied", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: outside.ts\n*** End Patch";
  const decision = decide(root, ev("write", { patch }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

// --- classifier depth -------------------------------------------------------

test("hardening: sed --in-place is a write", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "sed --in-place s/a/b/ lib/x.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: cd .git does not hide a denied path", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "cd .git && rm config" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /denied/);
});

test("hardening: cd outside the repo does not launder a relative path", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const outside = fs.mkdtempSync("/var/tmp/ratchet-cd-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const decision = decide(root, ev("bash", { command: `cd ${outside} && rm src/victim.txt` }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: cd into the scope still allows a relative write", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "cd src && rm a.ts" }));
  assert.equal(decision.allow, true);
});

test("hardening: cd plus a shell wrapper does not launder a relative path", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const outside = fs.mkdtempSync("/var/tmp/ratchet-cd-wrap-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const decision = decide(root, ev("bash", { command: `cd ${outside} && bash -c 'rm src/victim.txt'` }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

test("hardening: cd to an unresolvable directory fails closed", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  for (const command of ["cd $HOME && rm src/a.ts", "cd ~/elsewhere && rm src/a.ts", "cd - && rm src/a.ts"]) {
    const decision = decide(root, ev("bash", { command }));
    assert.equal(decision.allow, false, command);
    assert.match(decision.reason, /outside scope/, command);
  }
});

test("hardening: env with a value flag still exposes the wrapped command", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "env -u FOO rm lib/a.ts" }));
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside scope/);
});

// --- regressions ------------------------------------------------------------

test("hardening: ordinary redirects are not treated as operands", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "rm -rf src/build 2>/dev/null" }));
  assert.equal(decision.allow, true);
});

test("hardening: npnm install stays allowed and unresolved", (t) => {
  const root = repo(t);
  const decision = decide(root, ev("bash", { command: "npm install" }));
  assert.equal(decision.allow, true);
  assert.equal(decision.unresolved, true);
});

test("hardening: git add inside scope stays allowed", (t) => {
  const root = repo(t, { scope: ["src/**"] });
  const decision = decide(root, ev("bash", { command: "git add src/a.ts" }));
  assert.equal(decision.allow, true);
});
