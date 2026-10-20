import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checksPath, createContract, eventsPath, saveContract } from "../lib/contract.mjs";
import { lockCheckSurface } from "../lib/check-surface.mjs";
import { readJson, readJsonl } from "../lib/fsx.mjs";
import { DEFAULT_MAX_ATTEMPTS, evaluateStop, stopBlocks } from "../lib/stop.mjs";
import { appendEvent, parseEvent } from "../lib/events.mjs";

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.error(\'boom\'); process.exit(1)"';

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function emptyRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repo(t, opts = {}) {
  const root = emptyRepo(t);
  const contract = createContract(root, { goal: "stop test", role: "coder", scope: ["src/**"], ...opts });
  saveContract(root, contract);
  return { root, contract };
}

function stopEvent(last_message = "done") {
  return parseEvent({ type: "turn.stop", harness: "test", session_id: "s-1", last_message });
}

const CHECK = 'import fs from "node:fs";\nfs.appendFileSync("runs.log", "x\\n");\nprocess.exit(0);\n';

/** A repo whose verify command points at a real check file, locked at contract time. */
function lockedRepo(t) {
  const root = emptyRepo(t);
  fs.mkdirSync(path.join(root, ".ratchet"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ratchet", "config.json"), JSON.stringify({ version: 1, checks: [] }, null, 2));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts: { check: "node check.mjs" } }, null, 2));
  fs.writeFileSync(path.join(root, "check.mjs"), CHECK);
  const verify = ["node check.mjs"];
  const contract = createContract(root, {
    goal: "lock surface",
    role: "coder",
    scope: ["**"],
    verify,
    checkSurface: lockCheckSurface(root, verify),
  });
  saveContract(root, contract);
  return { root, contract };
}

function checkRuns(root) {
  const file = path.join(root, "runs.log");
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

test("stop: a failing verify blocks the turn and leaves evidence", (t) => {
  const { root, contract } = repo(t, { verify: [FAIL] });
  const decision = evaluateStop(root, stopEvent());

  assert.equal(decision.allow, false);
  assert.equal(decision.certified, false);
  assert.match(decision.reason, /checks failed/);
  assert.match(decision.reason, /verify-1/);
  assert.match(decision.reason, /boom/);
  assert.equal(decision.evidence, `.ratchet/runs/${contract.id}/checks.json`);
  assert.equal(fs.existsSync(path.join(root, decision.evidence)), true);
  assert.equal(decision.attempts, 1);
  assert.equal(decision.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(decision.checks.ok, false);
});

test("stop: a passing verify certifies the turn", (t) => {
  const { root, contract } = repo(t, { verify: [PASS] });
  const decision = evaluateStop(root, stopEvent());

  assert.equal(decision.allow, true);
  assert.equal(decision.certified, true);
  assert.equal(decision.reason, null);
  assert.equal(decision.attempts, 1);
  assert.equal(decision.evidence, `.ratchet/runs/${contract.id}/checks.json`);
  assert.equal(readJson(checksPath(root, contract.id)).ok, true);
});

test("stop: no contract allows the turn but never certifies it", (t) => {
  const root = emptyRepo(t);
  const decision = evaluateStop(root, stopEvent());

  assert.equal(decision.allow, true);
  assert.equal(decision.certified, false);
  assert.match(decision.reason, /no active contract/);
  assert.equal(decision.evidence, null);
  assert.equal(decision.attempts, 0);
  assert.equal(decision.checks, null);
});

test("stop: a contract with no verify commands allows the turn uncertified", (t) => {
  const { root } = repo(t, { verify: [] });
  const decision = evaluateStop(root, stopEvent());

  assert.equal(decision.allow, true);
  assert.equal(decision.certified, false);
  assert.match(decision.reason, /no verify commands/);
  assert.equal(decision.evidence, null);
  assert.equal(decision.attempts, 0);
  assert.equal(decision.checks, null);
});

test("stop: blocks accumulate and the loop caps without running checks", (t) => {
  const { root, contract } = repo(t, { verify: [FAIL] });
  const event = stopEvent();

  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    const decision = evaluateStop(root, event);
    assert.equal(decision.allow, false);
    assert.equal(decision.attempts, attempt);
    appendEvent(root, event, decision);
  }
  assert.equal(stopBlocks(root, contract.id), DEFAULT_MAX_ATTEMPTS);

  const before = readJson(checksPath(root, contract.id));
  const capped = evaluateStop(root, event);
  const after = readJson(checksPath(root, contract.id));

  assert.equal(capped.allow, true);
  assert.equal(capped.certified, false);
  assert.match(capped.reason, /capped/);
  assert.equal(capped.attempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(capped.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(capped.checks, null);
  assert.equal(after.ranAt, before.ranAt);
});

test("stop: the maxAttempts option caps after one block", (t) => {
  const { root, contract } = repo(t, { verify: [FAIL] });
  const event = stopEvent();

  appendEvent(root, event, evaluateStop(root, event));
  const capped = evaluateStop(root, event, { maxAttempts: 1 });

  assert.equal(capped.allow, true);
  assert.equal(capped.certified, false);
  assert.match(capped.reason, /capped at 1 attempts/);
  assert.equal(capped.maxAttempts, 1);
  assert.equal(capped.attempts, 1);
  assert.equal(capped.checks, null);
});

test("stop: an invalid maxAttempts falls back to the default", (t) => {
  const root = emptyRepo(t);
  assert.equal(evaluateStop(root, stopEvent(), { maxAttempts: 0 }).maxAttempts, DEFAULT_MAX_ATTEMPTS);
});

test("stop: the recorded row is a block with hashed text and attempt 1", (t) => {
  const { root, contract } = repo(t, { verify: [FAIL] });
  const lastMessage = "secret last message";
  const event = stopEvent(lastMessage);

  appendEvent(root, event, evaluateStop(root, event));
  const row = readJsonl(eventsPath(root, contract.id)).find((r) => r.type === "turn.stop");

  assert.equal(row.type, "turn.stop");
  assert.equal(row.decision, "block");
  assert.equal(row.tool, "stop");
  assert.equal(row.op, "stop");
  assert.equal(row.attempts, 1);
  assert.equal(row.certified, false);
  assert.equal("last_message" in row, false);
  assert.equal(row.last_message_sha256, sha256(lastMessage));
  assert.equal(row.last_message_length, lastMessage.length);
  assert.equal(JSON.stringify(row).includes(lastMessage), false);
  assert.ok(Array.isArray(row.checks));
});

test("stop: an unchanged surface certifies and reports the lock as ok", (t) => {
  const { root } = lockedRepo(t);
  const decision = evaluateStop(root, stopEvent());

  assert.equal(decision.allow, true);
  assert.equal(decision.certified, true);
  assert.equal(decision.checksLock, "ok");
  assert.equal(checkRuns(root), 1);
});

test("stop: editing package.json scripts after the lock blocks without running checks", (t) => {
  const { root, contract } = lockedRepo(t);
  assert.equal(evaluateStop(root, stopEvent()).certified, true);
  const before = readJson(checksPath(root, contract.id));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "x", scripts: { check: 'node -e "process.exit(0)"' } }, null, 2),
  );
  const blocked = evaluateStop(root, stopEvent());

  assert.equal(blocked.allow, false);
  assert.equal(blocked.certified, false);
  assert.equal(blocked.reason, "check surface changed: package scripts changed");
  assert.equal(blocked.evidence, null);
  assert.equal(blocked.checks, null);
  assert.equal(blocked.checksLock, "changed");
  assert.equal(blocked.attempts, 1);
  assert.equal(checkRuns(root), 1);
  assert.equal(readJson(checksPath(root, contract.id)).ranAt, before.ranAt);
});

test("stop: editing a referenced check file after the lock blocks", (t) => {
  const { root, contract } = lockedRepo(t);
  assert.equal(evaluateStop(root, stopEvent()).certified, true);
  const before = readJson(checksPath(root, contract.id));

  fs.writeFileSync(path.join(root, "check.mjs"), `// weakened\n${CHECK}`);
  const blocked = evaluateStop(root, stopEvent());

  assert.equal(blocked.allow, false);
  assert.equal(blocked.reason, "check surface changed: changed check file: check.mjs");
  assert.equal(blocked.evidence, null);
  assert.equal(blocked.checks, null);
  assert.equal(blocked.checksLock, "changed");
  assert.equal(checkRuns(root), 1);
  assert.equal(readJson(checksPath(root, contract.id)).ranAt, before.ranAt);
});

test("stop: editing an unrelated file still runs the checks", (t) => {
  const { root } = lockedRepo(t);
  assert.equal(evaluateStop(root, stopEvent()).certified, true);

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1\n");
  const decision = evaluateStop(root, stopEvent());

  assert.equal(decision.allow, true);
  assert.equal(decision.certified, true);
  assert.equal(decision.checksLock, "ok");
  assert.equal(checkRuns(root), 2);
});

test("stop: a contract without a lock still certifies and reports the lock missing", (t) => {
  const { root } = repo(t, { verify: [PASS] });
  const decision = evaluateStop(root, stopEvent());

  assert.equal(decision.allow, true);
  assert.equal(decision.certified, true);
  assert.equal(decision.checksLock, "missing");
});

test("stop: repeated surface blocks count as attempts and still reach the cap", (t) => {
  const { root, contract } = lockedRepo(t);
  fs.writeFileSync(path.join(root, "check.mjs"), `// weakened\n${CHECK}`);
  const event = stopEvent();

  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    const decision = evaluateStop(root, event);
    assert.equal(decision.allow, false);
    assert.equal(decision.attempts, attempt);
    assert.equal(decision.checksLock, "changed");
    appendEvent(root, event, decision);
  }
  assert.equal(stopBlocks(root, contract.id), DEFAULT_MAX_ATTEMPTS);

  const capped = evaluateStop(root, event);
  assert.equal(capped.allow, true);
  assert.equal(capped.certified, false);
  assert.match(capped.reason, /capped/);
  assert.equal(capped.checksLock, "unverified");
  assert.equal(checkRuns(root), 0);
});

test("stop: the recorded block row carries the lock state", (t) => {
  const { root, contract } = lockedRepo(t);
  fs.writeFileSync(path.join(root, "check.mjs"), `// weakened\n${CHECK}`);
  const event = stopEvent();

  appendEvent(root, event, evaluateStop(root, event));
  const row = readJsonl(eventsPath(root, contract.id)).find((r) => r.type === "turn.stop");

  assert.equal(row.decision, "block");
  assert.equal(row.checks_lock, "changed");
});
