import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildDigest } from "../lib/digest.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-digest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".ratchet", "runs"), { recursive: true });
  return dir;
}

function run(dir, id, createdAt, { events = 0, verdict = "done", checks = null, result = {} } = {}) {
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
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ verdict, ...result }));
  if (checks !== null) {
    fs.writeFileSync(path.join(runDir, "checks.json"), JSON.stringify({ ok: checks, ranAt: createdAt, results: [] }));
  }
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

test("digest v2: amendments, approvals, outside scope, and failed checks are decisions", (t) => {
  const dir = root(t);
  run(dir, "20260101-wired", "2026-01-01T00:00:00.000Z", { events: 3 });
  run(dir, "20260102-exceptions", "2026-01-02T00:00:00.000Z", {
    events: 2,
    checks: false,
    result: {
      scopeAudit: { outside: ["lib/leak.ts"] },
      amendments: [{ reason: "added tests for the retry path" }],
      approvals: [{ rule: "force-push", reason: "fresh public history" }],
    },
  });

  const digest = buildDigest(dir);
  assert.equal(digest.version, 2);
  const kinds = new Set(digest.exceptions.filter((entry) => entry.run === "20260102-exceptions").map((entry) => entry.kind));
  assert.deepEqual(
    [...kinds].sort(),
    ["amendment", "approval", "checks-failed", "outside-scope"],
  );
  assert.equal(digest.exceptions.every((entry) => entry.reason.length > 0), true);
  assert.equal(digest.decisions.length, 4);
  assert.equal(digest.decisions.every((entry) => entry.run && entry.next), true);
  assert.equal(digest.decisions.some((entry) => entry.next.startsWith("ratchet evidence --run")), true);
  // attention is still the worker queue; these are now decisions.
  assert.equal(digest.attention.some((item) => /outside scope|failing checks|amendment/.test(item)), false);
});

test("digest v2: a failed CI status joins the decision queue", (t) => {
  const dir = root(t);
  run(dir, "20260101-ci", "2026-01-01T00:00:00.000Z", { events: 1 });

  const digest = buildDigest(dir, {
    ci: {
      run: "20260101-ci",
      commit: "abc123",
      status: {
        state: "fail",
        workflow: "ci",
        url: "https://example.test/run/1",
        checkedAt: "2026-01-01T00:00:00.000Z",
        reason: "workflow ci concluded failure",
      },
    },
  });
  assert.equal(digest.counts.ciFail, 1);
  assert.equal(digest.ci.status.state, "fail");
  assert.equal(digest.exceptions.some((entry) => entry.kind === "ci-failed"), true);
  const decision = digest.decisions.find((entry) => entry.kind === "ci-failed");
  assert.equal(decision.next, "ratchet ci --run 20260101-ci");
});

test("digest v2: a passing CI status is reported but creates no decision", (t) => {
  const dir = root(t);
  run(dir, "20260101-ci", "2026-01-01T00:00:00.000Z", { events: 1 });
  const digest = buildDigest(dir, {
    ci: {
      run: "20260101-ci",
      commit: "abc123",
      status: { state: "pass", workflow: "ci", url: "https://example.test/run/1", reason: "ci succeeded" },
    },
  });
  assert.equal(digest.counts.ciPass, 1);
  assert.equal(digest.decisions.length, 0);
  assert.equal(digest.exceptions.length, 0);
});

test("digest CLI: --root prints one rollup per project, and one root keeps the v1 shape", (t) => {
  const first = root(t);
  const second = root(t);
  run(first, "20260101-a", "2026-01-01T00:00:00.000Z", { events: 2 });
  run(second, "20260102-b", "2026-01-02T00:00:00.000Z", { events: 2 });

  const single = spawnSync(process.execPath, [BIN, "digest", "--root", first, "--json"], {
    cwd: first,
    encoding: "utf8",
  });
  assert.equal(single.status, 0, single.stderr);
  const one = JSON.parse(single.stdout);
  assert.equal(one.total, 1);
  assert.equal(one.root, first);

  const multi = spawnSync(
    process.execPath,
    [BIN, "digest", "--root", first, "--root", second, "--json"],
    { cwd: first, encoding: "utf8" },
  );
  assert.equal(multi.status, 0, multi.stderr);
  const many = JSON.parse(multi.stdout);
  assert.equal(many.roots.length, 2);
  assert.deepEqual(
    many.roots.map((entry) => entry.total),
    [1, 1],
  );

  const text = spawnSync(process.execPath, [BIN, "digest", "--root", first, "--root", second], {
    cwd: first,
    encoding: "utf8",
  });
  assert.equal(text.status, 0, text.stderr);
  assert.equal((text.stdout.match(/RATCHET DIGEST/g) ?? []).length, 2);
});

test("digest CLI: an explicit --root with no runs prints a zero rollup", (t) => {
  const dir = root(t);
  const result = spawnSync(process.execPath, [BIN, "digest", "--root", dir], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RATCHET DIGEST/);
  assert.match(result.stdout, /runs:       0/);
  assert.match(result.stdout, /ratchet task start/);

  const json = spawnSync(process.execPath, [BIN, "digest", "--root", dir, "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.total, 0);
  assert.equal(parsed.root, dir);
  assert.equal(parsed.healthy, true);
});

test("digest CLI: decisions and exceptions are printed with next commands", (t) => {
  const dir = root(t);
  run(dir, "20260101-wired", "2026-01-01T00:00:00.000Z", { events: 3 });
  run(dir, "20260102-outside", "2026-01-02T00:00:00.000Z", {
    events: 1,
    checks: false,
    result: { scopeAudit: { outside: ["lib/leak.ts"] } },
  });

  const result = spawnSync(process.execPath, [BIN, "digest"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /decisions:/);
  assert.match(result.stdout, /exceptions:/);
  assert.match(result.stdout, /ratchet evidence --run 20260102-outside/);
});
