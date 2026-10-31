import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addSessionAlias,
  contractSessions,
  createContract,
  detectChecks,
  liveRuns,
  loadRun,
  loadRunForSession,
  normaliseTarget,
  saveContract,
} from "../lib/contract.mjs";
import { toPosix } from "../lib/fsx.mjs";
import { outsideDir } from "./helpers.mjs";

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
  const outside = outsideDir(t, "normalise-");
  assert.equal(normaliseTarget(root, root, outside), toPosix(fs.realpathSync(outside)));
});

test("normaliseTarget: expands a leading tilde", (t) => {
  const root = temp(t);
  const home = fs.realpathSync(os.homedir());
  assert.equal(normaliseTarget(root, root, "~/notes.txt"), toPosix(path.join(home, "notes.txt")));
  assert.equal(normaliseTarget(root, root, "~"), toPosix(home));
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
  assert.equal(contract.budgets.maxWrites, 120);
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

test("contractSessions: lead session plus aliases, deduped", (t) => {
  const root = temp(t);
  const contract = createContract(root, { goal: "g", role: "coder", scope: ["src/**"] });
  assert.deepEqual(contractSessions(contract), []);
  contract.session_id = "lead";
  assert.equal(addSessionAlias(contract, "child"), true);
  assert.equal(addSessionAlias(contract, "child"), false);
  assert.equal(addSessionAlias(contract, "lead"), false);
  assert.equal(addSessionAlias(contract, ""), false);
  assert.deepEqual(contractSessions(contract), ["lead", "child"]);
});

test("loadRunForSession: a worker alias resolves the lead contract", (t) => {
  const root = temp(t);
  const lead = createContract(root, { goal: "lead", role: "coder", scope: ["src/**"] });
  lead.session_id = "lead";
  addSessionAlias(lead, "child");
  saveContract(root, lead);

  assert.equal(loadRunForSession(root, "lead")?.id, lead.id);
  assert.equal(loadRunForSession(root, "child")?.id, lead.id);
  // The alias does not make the contract a manual fallback for other sessions.
  assert.equal(loadRunForSession(root, "other"), null);
});

test("liveRuns: the pointer and session-bound runs are live, stranded runs are not", (t) => {
  const root = temp(t);
  const stranded = createContract(root, { goal: "stranded", role: "coder", scope: ["web/**"] });
  stranded.createdAt = "2026-01-01T00:00:00.000Z";
  saveContract(root, stranded);

  const bound = createContract(root, { goal: "bound", role: "coder", scope: ["src/**"] });
  bound.session_id = "s-a";
  bound.createdAt = "2026-02-01T00:00:00.000Z";
  saveContract(root, bound);

  const manual = createContract(root, { goal: "manual", role: "coder", scope: ["lib/**"] });
  manual.createdAt = "2026-03-01T00:00:00.000Z";
  saveContract(root, manual);

  const closed = createContract(root, { goal: "closed", role: "coder", scope: ["src/**"] });
  closed.session_id = "s-b";
  closed.createdAt = "2026-04-01T00:00:00.000Z";
  saveContract(root, closed);
  fs.writeFileSync(path.join(root, ".ratchet", "runs", closed.id, "result.json"), "{}\n");
  // A finished run does not own the pointer; put it back on the manual run.
  saveContract(root, manual);

  assert.deepEqual(
    liveRuns(root).map((contract) => contract.id).sort(),
    [bound.id, manual.id].sort(),
  );
});

test("createContract: two contracts with the same goal do not overwrite each other", (t) => {
  const root = temp(t);
  const first = createContract(root, { goal: "same goal", role: "coder", scope: ["src/**"] });
  saveContract(root, first);
  const second = createContract(root, { goal: "same goal", role: "coder", scope: ["src/**"] });
  saveContract(root, second);

  assert.notEqual(first.id, second.id);
  assert.equal(loadRun(root, first.id)?.id, first.id);
  assert.equal(loadRun(root, second.id)?.id, second.id);
});
