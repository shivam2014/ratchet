import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChecks } from "../lib/checks.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-checks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

function script(root, name, body) {
  fs.writeFileSync(path.join(root, name), body);
  return `node ${name}`;
}

test("checks: passing command", (t) => {
  const root = temp(t);
  const report = runChecks(root, [{ id: "ok", cmd: script(root, "ok.mjs", "process.exit(0);\n") }], {
    timeoutMs: 10000,
  });
  assert.equal(report.ok, true);
  assert.equal(report.results[0].status, 0);
});

test("checks: failing command", (t) => {
  const root = temp(t);
  const report = runChecks(root, [{ id: "bad", cmd: script(root, "bad.mjs", "process.exit(3);\n") }], {
    timeoutMs: 10000,
  });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, 3);
});

test("checks: timeout is a failure", (t) => {
  const root = temp(t);
  const report = runChecks(
    root,
    [{ id: "slow", cmd: script(root, "slow.mjs", "setTimeout(() => {}, 5000);\n") }],
    { timeoutMs: 100 },
  );
  assert.equal(report.ok, false);
  assert.notEqual(report.results[0].status, 0);
});

test("checks: failure context keeps the failing test block", (t) => {
  const root = temp(t);
  const cmd = script(
    root,
    "fail.mjs",
    "console.log('not ok 1 - example');\nconsole.log('  error: boom');\nprocess.exit(1);\n",
  );
  const report = runChecks(root, [{ id: "fail", cmd }], { timeoutMs: 10000 });
  assert.equal(report.ok, false);
  assert.match(report.results[0].failure, /not ok 1 - example/);
  assert.match(report.results[0].failure, /error: boom/);
});

test("checks: no checks is not a pass", () => {
  const report = runChecks(process.cwd(), []);
  assert.equal(report.ok, false);
  assert.equal(report.empty, true);
});
