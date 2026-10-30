import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadRun, loadRunForSession, liveRuns } from "../lib/contract.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const VERIFY = 'node -e "process.exit(0)"';

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-thread-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "thread", private: true }, null, 2));
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  const init = ratchet(dir, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

function ratchet(cwd, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: "utf8" });
}

function start(dir, goal, session, extra = []) {
  const args = [
    "task", "start",
    "--role", "coder",
    "--goal", goal,
    "--scope", "src/**",
    "--verify", VERIFY,
    ...(session ? ["--session", session] : []),
    ...extra,
  ];
  return ratchet(dir, args);
}

function started(result) {
  const match = result.stdout.match(/^run:\s+(\S+)$/m);
  return match?.[1] ?? null;
}

function resultFor(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "result.json"), "utf8"));
}

function hook(dir, session, writePath) {
  return ratchet(
    dir,
    ["hook"],
    JSON.stringify({
      type: "tool.before",
      harness: "test",
      session_id: session,
      tool: "write",
      input: { path: writePath },
      cwd: dir,
    }),
  );
}

test("thread: two session contracts can be live in one checkout", (t) => {
  const dir = repo(t);
  const a = start(dir, "lead a", "s-a");
  assert.equal(a.status, 0, a.stderr);
  const idA = started(a);
  const b = start(dir, "lead b", "s-b");
  assert.equal(b.status, 0, b.stderr);
  const idB = started(b);
  assert.ok(idA && idB);
  assert.notEqual(idA, idB);
  assert.match(b.stdout, /2 live contracts now share this checkout/);
  assert.match(b.stdout, /one worktree per lead/);

  assert.equal(loadRunForSession(dir, "s-a")?.id, idA);
  assert.equal(loadRunForSession(dir, "s-b")?.id, idB);
  assert.deepEqual(liveRuns(dir).map((run) => run.id).sort(), [idA, idB].sort());
});

test("thread: check and task status resolve by session, not by the pointer", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-a"));
  const idB = started(start(dir, "lead b", "s-b"));
  // The pointer follows the newest start; session A still owns its own run.
  assert.equal(loadRun(dir)?.id, idB);

  const status = ratchet(dir, ["task", "status", "--session", "s-a"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`run:\\s+${idA}`));
  assert.match(status.stdout, /goal:\s+lead a/);
  assert.match(status.stdout, /session:\s+s-a/);

  const check = ratchet(dir, ["check", "--session", "s-a"]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /PASS/);
  assert.ok(fs.existsSync(path.join(dir, ".ratchet", "runs", idA, "checks.json")));
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "runs", idB, "checks.json")), false);

  const global = ratchet(dir, ["status", "--session", "s-a"]);
  assert.equal(global.status, 0, global.stderr);
  assert.match(global.stdout, new RegExp(`contract:\\s+${idA}`));
});

test("thread: done --session closes one contract and leaves the other live", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-a"));
  const idB = started(start(dir, "lead b", "s-b"));

  assert.equal(ratchet(dir, ["check", "--session", "s-a"]).status, 0);
  const done = ratchet(dir, ["done", "--session", "s-a"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`DONE\\s+${idA}`));
  assert.match(done.stdout, /1 other live contract\(s\) remain/);

  assert.equal(resultFor(dir, idA).verdict, "done");
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "runs", idB, "result.json")), false);
  assert.equal(loadRunForSession(dir, "s-a"), null);
  assert.equal(loadRunForSession(dir, "s-b")?.id, idB);
  // The pointer names B, so closing A must not clear it.
  assert.equal(loadRun(dir)?.id, idB);
});

test("thread: a manual contract still refuses a second start", (t) => {
  const dir = repo(t);
  const first = start(dir, "manual first");
  assert.equal(first.status, 0, first.stderr);
  const firstId = started(first);

  const second = start(dir, "manual second");
  assert.equal(second.status, 1);
  assert.match(second.stderr, new RegExp(`a contract is still live: ${firstId}`));
  assert.match(second.stderr, /ratchet task start --force/);

  const bySession = start(dir, "session over manual", "s-a");
  assert.equal(bySession.status, 1);
  assert.match(bySession.stderr, /a manual contract is still live/);
  assert.match(bySession.stderr, /ratchet task bind --session s-a/);

  // --force still replaces the manual contract the caller owns.
  const replaced = start(dir, "manual replaced", null, ["--force"]);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(replaced.stdout, new RegExp(`superseded: ${firstId}`));
  assert.equal(resultFor(dir, firstId).verdict, "abandoned");
});

test("thread: a manual start refuses while a session contract is live", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-a"));

  const manual = start(dir, "manual intruder");
  assert.equal(manual.status, 1);
  assert.match(manual.stderr, /session-bound contract\(s\) are live/);
  assert.match(manual.stderr, /one worktree per lead/);

  // Even --force cannot turn a session boundary into a manual one, and it must
  // not abandon the session's contract.
  const forced = start(dir, "manual forced", null, ["--force"]);
  assert.equal(forced.status, 1);
  assert.equal(loadRunForSession(dir, "s-a")?.id, idA);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "runs", idA, "result.json")), false);
});

test("thread: --force replaces only the caller's session contract", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-a"));
  const idB = started(start(dir, "lead b", "s-b"));

  const replaced = start(dir, "lead a v2", "s-a", ["--force"]);
  assert.equal(replaced.status, 0, replaced.stderr);
  const idA2 = started(replaced);
  assert.notEqual(idA2, idA);
  assert.match(replaced.stdout, new RegExp(`superseded: ${idA}`));

  assert.equal(resultFor(dir, idA).verdict, "abandoned");
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "runs", idB, "result.json")), false);
  assert.equal(loadRunForSession(dir, "s-a")?.id, idA2);
  assert.equal(loadRunForSession(dir, "s-b")?.id, idB);
});

test("thread: task bind attaches a worker session to the lead's contract", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-lead"));
  const idB = started(start(dir, "lead b", "s-other"));
  assert.equal(loadRun(dir)?.id, idB);

  const bound = ratchet(dir, ["task", "bind", "--session", "s-child", "--run", idA]);
  assert.equal(bound.status, 0, bound.stderr);
  assert.match(bound.stdout, /BOUND\s+s-child/);
  // Binding metadata must not steal the CLI pointer from the live B run.
  assert.equal(loadRun(dir)?.id, idB);

  const leadContract = loadRun(dir, idA);
  assert.deepEqual(leadContract.aliases, ["s-child"]);
  assert.equal(loadRunForSession(dir, "s-child")?.id, idA);

  const workerStatus = ratchet(dir, ["task", "status", "--session", "s-child"]);
  assert.equal(workerStatus.status, 0, workerStatus.stderr);
  assert.match(workerStatus.stdout, new RegExp(`run:\\s+${idA}`));

  // The worker inherits the lead's write boundary instead of starting its own.
  assert.equal(hook(dir, "s-child", "src/allowed.ts").status, 0);
  const denied = hook(dir, "s-child", "lib/outside.ts");
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /outside scope/);

  // A bound session cannot be silently moved to another contract.
  const steal = ratchet(dir, ["task", "bind", "--session", "s-child", "--run", idB]);
  assert.equal(steal.status, 1);
  assert.match(steal.stderr, /already bound/);

  // A worker alias inherits the boundary but not the right to close the run.
  const workerDone = ratchet(dir, ["done", "--session", "s-child"]);
  assert.equal(workerDone.status, 1);
  assert.match(workerDone.stderr, /worker alias/);

  const byLead = ratchet(dir, ["task", "bind", "--session", "s-grandchild", "--lead", "s-lead"]);
  assert.equal(byLead.status, 0, byLead.stderr);
  assert.equal(loadRunForSession(dir, "s-grandchild")?.id, idA);
  assert.deepEqual(loadRun(dir, idA).aliases, ["s-child", "s-grandchild"]);
});

test("thread: abandon --session closes one contract and refuses a worker", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-a"));
  const idB = started(start(dir, "lead b", "s-b"));
  assert.equal(ratchet(dir, ["task", "bind", "--session", "s-child", "--run", idA]).status, 0);

  const worker = ratchet(dir, ["abandon", "--session", "s-child", "--reason", "not mine"]);
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /worker alias/);

  const abandoned = ratchet(dir, ["abandon", "--session", "s-a", "--reason", "lead closed it"]);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.match(abandoned.stdout, new RegExp(`ABANDONED\\s+${idA}`));
  assert.match(abandoned.stdout, new RegExp(`still live: ${idB}`));
  assert.equal(resultFor(dir, idA).verdict, "abandoned");
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "runs", idB, "result.json")), false);
  assert.equal(loadRunForSession(dir, "s-b")?.id, idB);
});

test("thread: digest --thread filters rows by session and alias", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-a"));
  const idB = started(start(dir, "lead b", "s-b"));
  assert.equal(ratchet(dir, ["task", "bind", "--session", "s-child", "--run", idA]).status, 0);

  const filtered = ratchet(dir, ["digest", "--thread", "s-a", "--json"]);
  const parsed = JSON.parse(filtered.stdout);
  assert.equal(parsed.thread, "s-a");
  assert.equal(parsed.total, 1);
  assert.deepEqual(parsed.rows.map((row) => row.id), [idA]);
  assert.equal(parsed.rows[0].session, "s-a");
  assert.deepEqual(parsed.rows[0].aliases, ["s-child"]);
  assert.equal("healthy" in parsed, true);

  const byAlias = JSON.parse(ratchet(dir, ["digest", "--thread", "s-child", "--json"]).stdout);
  assert.equal(byAlias.total, 1);
  assert.deepEqual(byAlias.rows.map((row) => row.id), [idA]);

  const bOnly = ratchet(dir, ["digest", "--thread", "s-b"]);
  assert.match(bOnly.stdout, /for thread s-b/);
  assert.doesNotMatch(bOnly.stdout, /lead a/);
  const bJson = JSON.parse(ratchet(dir, ["digest", "--thread", "s-b", "--json"]).stdout);
  assert.deepEqual(bJson.rows.map((row) => row.id), [idB]);
  assert.equal(bJson.rows[0].goal, "lead b");
  assert.notEqual(idA, idB);

  const missing = ratchet(dir, ["digest", "--thread", "s-none"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No runs for thread s-none/);
});

test("thread: status lists every live contract and warns about the shared checkout", (t) => {
  const dir = repo(t);
  const idA = started(start(dir, "lead a", "s-a"));
  const idB = started(start(dir, "lead b", "s-b"));

  const status = ratchet(dir, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /live: 2 contract\(s\) in this checkout/);
  assert.match(status.stdout, new RegExp(`${idA}.*session: s-a.*lead a`));
  assert.match(status.stdout, new RegExp(`${idB}.*session: s-b.*lead b`));
  assert.match(status.stdout, /more than one live contract shares this checkout/);
  assert.match(status.stdout, /git index and working tree are shared/);
  assert.match(status.stdout, /file conflicts are still possible/);
  assert.match(status.stdout, /one worktree per lead/i);

  const sessionView = ratchet(dir, ["status", "--session", "s-a"]);
  assert.equal(sessionView.status, 0, sessionView.stderr);
  assert.match(sessionView.stdout, new RegExp(`contract:\\s+${idA}`));
  assert.match(sessionView.stdout, /live: 2 contract\(s\)/);
});
