import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createContract,
  detectChecks,
  loadRun,
  loadRunForSession,
  normaliseTarget,
  saveContract,
} from "../lib/contract.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function pkg(root, scripts) {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts }));
}

test("detectChecks: prefers a single check script", (t) => {
  const root = temp(t);
  pkg(root, { check: "node check.mjs", lint: "eslint .", test: "node --test" });
  assert.deepEqual(detectChecks(root), [{ id: "check", cmd: "npm run check" }]);
});

test("detectChecks: falls back to lint, typecheck, test, build in order", (t) => {
  const root = temp(t);
  pkg(root, { test: "node --test", build: "tsc", lint: "eslint .", typecheck: "tsc --noEmit" });
  assert.deepEqual(
    detectChecks(root).map((c) => c.id),
    ["lint", "typecheck", "test", "build"],
  );
});

test("detectChecks: no package.json means no checks", (t) => {
  const root = temp(t);
  assert.deepEqual(detectChecks(root), []);
});

test("normaliseTarget: relative to the event cwd", (t) => {
  const root = temp(t);
  assert.equal(normaliseTarget(root, path.join(root, "src"), "a.ts"), "src/a.ts");
});

test("normaliseTarget: absolute inside the repo", (t) => {
  const root = temp(t);
  assert.equal(normaliseTarget(root, root, path.join(root, "src/a.ts")), "src/a.ts");
});

test("normaliseTarget: absolute outside the repo stays absolute", (t) => {
  const root = temp(t);
  assert.equal(normaliseTarget(root, root, "/etc/passwd"), fs.realpathSync("/etc/passwd"));
});

test("normaliseTarget: expands a leading tilde", (t) => {
  const root = temp(t);
  const home = fs.realpathSync(process.env.HOME);
  assert.equal(normaliseTarget(root, root, "~/notes.txt"), path.join(home, "notes.txt"));
  assert.equal(normaliseTarget(root, root, "~"), home);
});

test("createContract: defaults and verify ids", (t) => {
  const root = temp(t);
  const contract = createContract(root, { goal: "g", role: "coder", scope: ["src/**"], verify: ["a", "b"] });
  assert.equal(contract.version, 1);
  assert.equal(contract.readOnly, false);
  assert.deepEqual(contract.verify, [
    { id: "verify-1", cmd: "a" },
    { id: "verify-2", cmd: "b" },
  ]);
  assert.equal(contract.budgets.maxFiles, 12);
});

test("loadRun: rejects a wrong contract version", (t) => {
  const root = temp(t);
  const dir = path.join(root, ".ratchet", "runs", "bad");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "contract.json"), JSON.stringify({ version: 999, id: "bad" }));
  fs.writeFileSync(path.join(root, ".ratchet", "current"), "bad\n");
  assert.equal(loadRun(root), null);
});

test("loadRun: reads the current contract", (t) => {
  const root = temp(t);
  const contract = createContract(root, { goal: "g", role: "coder", scope: ["src/**"] });
  saveContract(root, contract);
  assert.equal(loadRun(root)?.id, contract.id);
});

test("loadRunForSession: a session uses its own contract", (t) => {
  const root = temp(t);
  const a = createContract(root, { goal: "session a", role: "coder", scope: ["src/**"] });
  a.session_id = "A";
  saveContract(root, a);
  const b = createContract(root, { goal: "session b", role: "coder", scope: ["lib/**"] });
  b.session_id = "B";
  saveContract(root, b);

  assert.equal(loadRunForSession(root, "A")?.id, a.id);
  assert.equal(loadRunForSession(root, "B")?.id, b.id);
  assert.equal(loadRunForSession(root, "C"), null);
});

test("loadRunForSession: a manual contract is the fallback", (t) => {
  const root = temp(t);
  const bound = createContract(root, { goal: "auto", role: "coder", scope: ["src/**"] });
  bound.session_id = "A";
  saveContract(root, bound);
  const manual = createContract(root, { goal: "manual", role: "coder", scope: ["lib/**"] });
  saveContract(root, manual);

  assert.equal(loadRunForSession(root, "A")?.id, bound.id);
  assert.equal(loadRunForSession(root, "B")?.id, manual.id);
});

test("loadRunForSession: a stranded open run does not shadow the pointer", (t) => {
  const root = temp(t);
  const stranded = createContract(root, { goal: "stranded", role: "coder", scope: ["web/**"] });
  stranded.createdAt = "2026-01-01T00:00:00.000Z";
  saveContract(root, stranded);
  const current = createContract(root, { goal: "current", role: "coder", scope: ["**"] });
  current.createdAt = "2026-02-01T00:00:00.000Z";
  saveContract(root, current);

  // `done` writes result.json and clears the pointer. The older run is still
  // open (no result), but it must not keep enforcing web/**.
  fs.writeFileSync(path.join(root, ".ratchet", "runs", current.id, "result.json"), "{}\n");
  fs.rmSync(path.join(root, ".ratchet", "current"), { force: true });

  assert.equal(loadRunForSession(root, "s1"), null);
});
