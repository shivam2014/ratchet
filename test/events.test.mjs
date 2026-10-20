import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createContract, eventsPath, saveContract } from "../lib/contract.mjs";
import {
  DECISION_SCHEMA,
  EVENT_SCHEMA,
  EVENT_TYPES,
  EVENT_VERSION,
  EventError,
  appendEvent,
  parseEvent,
  rowFor,
} from "../lib/events.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const promptSubmit = (extra = {}) => ({
  type: "prompt.submit",
  harness: "claude",
  session_id: "s-1",
  prompt: "add the parser",
  ...extra,
});

const toolBefore = (extra = {}) => ({
  type: "tool.before",
  harness: "cursor",
  session_id: "s-1",
  tool: "write",
  input: { path: "src/a.ts" },
  ...extra,
});

const toolAfter = (extra = {}) => ({
  type: "tool.after",
  harness: "pi",
  session_id: "s-1",
  tool: "edit",
  input: { path: "src/a.ts" },
  result: { exit: 0 },
  ...extra,
});

const turnStop = (extra = {}) => ({
  type: "turn.stop",
  harness: "t3",
  session_id: "s-1",
  cwd: "/repo",
  ...extra,
});

test("events: documented examples parse into the normalized shape", () => {
  assert.deepEqual(parseEvent({ ...promptSubmit(), cwd: "/repo" }), {
    version: EVENT_VERSION,
    type: "prompt.submit",
    harness: "claude",
    session_id: "s-1",
    cwd: "/repo",
    prompt: "add the parser",
  });
  assert.deepEqual(parseEvent({ ...toolBefore(), cwd: "/repo" }), {
    version: EVENT_VERSION,
    type: "tool.before",
    harness: "cursor",
    session_id: "s-1",
    cwd: "/repo",
    tool: "write",
    input: { path: "src/a.ts" },
  });
  assert.deepEqual(parseEvent({ ...toolAfter(), cwd: "/repo" }), {
    version: EVENT_VERSION,
    type: "tool.after",
    harness: "pi",
    session_id: "s-1",
    cwd: "/repo",
    tool: "edit",
    input: { path: "src/a.ts" },
    result: { exit: 0 },
  });
  assert.deepEqual(parseEvent(turnStop({ last_message: "done" })), {
    version: EVENT_VERSION,
    type: "turn.stop",
    harness: "t3",
    session_id: "s-1",
    cwd: "/repo",
    last_message: "done",
  });
});

test("events: cwd defaults and session_id numbers are stringified", () => {
  const event = parseEvent({ ...toolBefore(), session_id: 42 });
  assert.equal(event.cwd, process.cwd());
  assert.equal(event.session_id, "42");
});

test("events: last_message defaults to null", () => {
  assert.equal(parseEvent(turnStop()).last_message, null);
});

test("events: unknown type throws and lists the valid types", () => {
  assert.throws(
    () => parseEvent({ type: "nope", harness: "claude", session_id: "s-1" }),
    (err) => {
      assert.ok(err instanceof EventError);
      assert.match(err.message, /not supported/);
      for (const type of EVENT_TYPES) assert.ok(err.message.includes(type), `${type} listed`);
      return true;
    },
  );
});

test("events: type is required", () => {
  assert.throws(
    () => parseEvent({ harness: "claude", session_id: "s-1" }),
    (err) => err instanceof EventError && /type is required/.test(err.message) && /prompt\.submit/.test(err.message),
  );
});

test("events: a missing required field throws naming the field", () => {
  const withoutInput = toolBefore();
  delete withoutInput.input;
  assert.throws(
    () => parseEvent(withoutInput),
    (err) => err instanceof EventError && err.message === 'event tool.before needs "input"',
  );
  assert.throws(
    () => parseEvent({ type: "tool.after", harness: "pi", session_id: "s-1", tool: "edit", input: {} }),
    /event tool\.after needs "result"/,
  );
});

test("events: wrong field types throw", () => {
  const cases = [
    [promptSubmit({ harness: "" }), /harness/],
    [promptSubmit({ session_id: true }), /session_id/],
    [promptSubmit({ cwd: 5 }), /cwd/],
    [promptSubmit({ prompt: 1 }), /prompt/],
    [toolBefore({ tool: "" }), /tool/],
    [toolBefore({ input: [] }), /input/],
    [toolAfter({ result: null }), /result/],
    [turnStop({ last_message: 2 }), /last_message/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(
      () => parseEvent(raw),
      (err) => err instanceof EventError && pattern.test(err.message),
      JSON.stringify(raw),
    );
  }
});

test("events: non-objects are rejected", () => {
  for (const raw of [null, [], "prompt.submit", 42]) {
    assert.throws(() => parseEvent(raw), EventError);
  }
});

test("events: an unsupported version throws", () => {
  assert.throws(
    () => parseEvent({ ...promptSubmit(), version: 2 }),
    (err) => err instanceof EventError && err.message === "event version 2 is not supported (expected 1)",
  );
});

test("events: unknown keys are dropped", () => {
  const event = parseEvent(promptSubmit({ extra: "x", paths: ["src/a.ts"], last_message: "nope" }));
  assert.deepEqual(Object.keys(event), ["version", "type", "harness", "session_id", "cwd", "prompt"]);
});

test("events: prompt.submit rows hash the prompt and never store it", () => {
  const prompt = "SECRET_PROMPT_TEXT";
  const event = parseEvent(promptSubmit({ prompt }));
  const row = rowFor(event, { context: "the brief" });

  assert.equal(row.type, "prompt.submit");
  assert.equal(row.tool, "prompt");
  assert.equal(row.op, "prompt");
  assert.equal(row.decision, "observed");
  assert.equal(row.prompt_sha256, sha256(prompt));
  assert.equal(row.prompt_length, prompt.length);
  assert.equal("run" in row, false);
  assert.equal(JSON.stringify(row).includes(prompt), false);

  assert.equal(rowFor(event, { context: null, run: "run-1" }).run, "run-1");
});

test("events: turn.stop rows hash the message and carry the verdict", () => {
  const lastMessage = "done, I think";
  const event = parseEvent(turnStop({ last_message: lastMessage }));
  const decision = {
    allow: false,
    certified: false,
    reason: "checks failed: verify-1",
    evidence: ".ratchet/runs/run-1/checks.json",
    attempts: 1,
    maxAttempts: 3,
    checks: { ok: false, ranAt: "2026-10-20T00:00:00.000Z", results: [{ id: "verify-1", status: 1 }] },
  };
  const row = rowFor(event, decision);

  assert.equal(row.tool, "stop");
  assert.equal(row.op, "stop");
  assert.equal(row.decision, "block");
  assert.equal(row.last_message_sha256, sha256(lastMessage));
  assert.equal(row.last_message_length, lastMessage.length);
  assert.equal("last_message" in row, false);
  assert.equal(JSON.stringify(row).includes(lastMessage), false);
  assert.equal(row.certified, false);
  assert.equal(row.attempts, 1);
  assert.equal(row.max_attempts, 3);
  assert.equal(row.evidence, ".ratchet/runs/run-1/checks.json");
  assert.deepEqual(row.checks, [{ id: "verify-1", status: 1 }]);
});

test("events: a null last_message writes no message fields", () => {
  const row = rowFor(parseEvent(turnStop()), { allow: true, certified: true, attempts: 1, maxAttempts: 3, evidence: null, checks: null });
  assert.equal("last_message_sha256" in row, false);
  assert.equal("last_message_length" in row, false);
  assert.equal(row.decision, "allow");
});

test("events: rowFor refuses tool.before, which record() owns", () => {
  assert.throws(
    () => rowFor(parseEvent(toolBefore()), { allow: true, op: "write", paths: ["src/a.ts"] }),
    (err) => err instanceof EventError && /record\(\)/.test(err.message),
  );
});

test("events: DECISION_SCHEMA covers every event type and nothing else", () => {
  assert.deepEqual(Object.keys(DECISION_SCHEMA).sort(), [...EVENT_TYPES].sort());
  assert.deepEqual(Object.keys(EVENT_SCHEMA).sort(), [...EVENT_TYPES].sort());
});

test("events: appendEvent writes to the active run and returns its id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-events-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const event = parseEvent(toolAfter());
  assert.equal(appendEvent(root, event, { continue: true, context: null }), null);

  const contract = createContract(root, { goal: "events", role: "coder", scope: ["src/**"] });
  saveContract(root, contract);
  assert.equal(appendEvent(root, event, { continue: true, context: null }), contract.id);

  const rows = fs
    .readFileSync(eventsPath(root, contract.id), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "tool.after");
  assert.equal(rows[0].exit, 0);
  assert.equal(rows[0].ok, true);
});
