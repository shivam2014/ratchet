import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDigest } from "../lib/digest.mjs";

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-digest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".ratchet", "runs"), { recursive: true });
  return dir;
}

function run(dir, id, createdAt, { events = 0, verdict = "done" } = {}) {
  const runDir = path.join(dir, ".ratchet", "runs", id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "contract.json"),
    JSON.stringify({
      version: 1,
      id,
      goal: id,
      role: "coder",
      createdAt,
      scope: ["**"],
      verify: [{ id: "verify-1", cmd: "true" }],
    }),
  );
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ verdict }));
  if (events) {
    fs.writeFileSync(
      path.join(runDir, "events.jsonl"),
      Array.from({ length: events }, () => JSON.stringify({ decision: "allow" })).join("\n") + "\n",
    );
  }
}

test("digest: blind runs before guard wiring are historical, not attention", (t) => {
  const dir = root(t);
  run(dir, "20260101-old", "2026-01-01T00:00:00.000Z", { events: 0 });
  run(dir, "20260102-wired", "2026-01-02T00:00:00.000Z", { events: 3 });

  const digest = buildDigest(dir);
  assert.equal(digest.counts.blind, 1);
  assert.equal(digest.counts.historicalBlind, 1);
  assert.equal(digest.counts.currentBlind, 0);
  assert.equal(digest.history.blind, 1);
  assert.equal(digest.attention.some((item) => item.includes("no guard events")), false);
});

test("digest: a blind run after wiring stays in attention", (t) => {
  const dir = root(t);
  run(dir, "20260101-old", "2026-01-01T00:00:00.000Z", { events: 0 });
  run(dir, "20260102-wired", "2026-01-02T00:00:00.000Z", { events: 3 });
  run(dir, "20260103-blind", "2026-01-03T00:00:00.000Z", { events: 0 });

  const digest = buildDigest(dir);
  assert.equal(digest.counts.historicalBlind, 1);
  assert.equal(digest.counts.currentBlind, 1);
  assert.equal(digest.attention.some((item) => item.startsWith("1 run(s) with no guard events")), true);
});
