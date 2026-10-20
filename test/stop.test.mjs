import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checksPath, createContract, eventsPath, saveContract } from "../lib/contract.mjs";
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
