import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChecks } from "../lib/checks.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-checks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("checks: passing command", (t) => {
  const root = temp(t);
  const report = runChecks(root, [{ id: "ok", cmd: 'node -e "process.exit(0)"' }], { timeoutMs: 10000 });
  assert.equal(report.ok, true);
  assert.equal(report.results[0].status, 0);
});

test("checks: failing command", (t) => {
  const root = temp(t);
  const report = runChecks(root, [{ id: "bad", cmd: 'node -e "process.exit(3)"' }], { timeoutMs: 10000 });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, 3);
});

test("checks: timeout is a failure", (t) => {
  const root = temp(t);
  const report = runChecks(root, [{ id: "slow", cmd: "sleep 2" }], { timeoutMs: 100 });
  assert.equal(report.ok, false);
  assert.notEqual(report.results[0].status, 0);
});

test("checks: no checks is not a pass", () => {
  const report = runChecks(process.cwd(), []);
  assert.equal(report.ok, false);
  assert.equal(report.empty, true);
});
