import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ciStatus, classifyRun, commitForRun } from "../lib/ci.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-ci-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".ratchet"), { recursive: true });
  return dir;
}

function runFixture(dir, id, contractExtra = {}, result = null) {
  const runDir = path.join(dir, ".ratchet", "runs", id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "contract.json"),
    JSON.stringify({ version: 1, id, goal: id, role: "coder", scope: ["**"], verify: [], ...contractExtra }),
  );
  if (result) fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result));
}

function saveEnv(keys) {
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Node cannot spawn a `.cmd` command shim on Windows without `shell: true`,
 * and lib/ci.mjs spawns "gh" directly. Probe the platform once: where a stub
 * is not runnable, the gh-backed tests are skipped with that exact reason
 * instead of failing on a fixture limitation.
 */
function commandShimRuns() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-gh-probe-"));
  const marker = "ratchet-gh-shim";
  try {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(dir, "gh.cmd"), `@echo off\r\necho ${marker}\r\n`);
    } else {
      const gh = path.join(dir, "gh");
      fs.writeFileSync(gh, `#!/bin/sh\necho ${marker}\n`);
      fs.chmodSync(gh, 0o755);
    }
    const probe = spawnSync("gh", ["--probe"], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    return probe.status === 0 && String(probe.stdout).includes(marker);
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GH_SKIP = commandShimRuns()
  ? false
  : "the fake gh command shim cannot run on this platform (native Windows cannot spawn a .cmd without a shell)";
const ghTest = (name, fn) => test(name, { skip: GH_SKIP }, fn);

/** Put a fake `gh` first on PATH; it logs argv and prints a fixed response. */
function fakeGh(t, response, { exit = 0, stderr = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-gh-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'if [ -n "$GH_LOG" ]; then printf "%s\\n" "$*" >> "$GH_LOG"; fi',
      'if [ -n "$GH_STDERR" ]; then printf "%s\\n" "$GH_STDERR" >&2; fi',
      'if [ "${GH_EXIT:-0}" != "0" ]; then exit "$GH_EXIT"; fi',
      'cat "$GH_RESPONSE"',
    ].join("\n") + "\n",
  );
  fs.chmodSync(gh, 0o755);
  const responseFile = path.join(dir, "response.json");
  fs.writeFileSync(responseFile, JSON.stringify(response));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");

  const restore = saveEnv(["PATH", "GH_LOG", "GH_STDERR", "GH_EXIT", "GH_RESPONSE"]);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.GH_LOG = log;
  process.env.GH_STDERR = stderr;
  process.env.GH_EXIT = String(exit);
  process.env.GH_RESPONSE = responseFile;
  t.after(() => {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    log,
    calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
    respond: (next, code = 0) => {
      fs.writeFileSync(responseFile, JSON.stringify(next));
      process.env.GH_EXIT = String(code);
    },
  };
}

const PASS = [
  {
    databaseId: 42,
    status: "completed",
    conclusion: "success",
    url: "https://github.com/acme/repo/actions/runs/42",
    workflowName: "ci",
  },
];

test("ci: classifyRun maps gh conclusions to four states", () => {
  assert.equal(classifyRun(PASS[0]), "pass");
  assert.equal(classifyRun({ status: "completed", conclusion: "failure" }), "fail");
  assert.equal(classifyRun({ status: "completed", conclusion: "timed_out" }), "fail");
  assert.equal(classifyRun({ status: "in_progress", conclusion: "" }), "running");
  assert.equal(classifyRun({ status: "queued", conclusion: "" }), "running");
  assert.equal(classifyRun({ status: "completed", conclusion: "neutral" }), "unknown");
  assert.equal(classifyRun(null), "unknown");
});

ghTest("ci: a completed successful run is a pass", (t) => {
  const dir = root(t);
  fakeGh(t, PASS);
  const status = ciStatus(dir, "abc123");
  assert.equal(status.state, "pass");
  assert.equal(status.url, PASS[0].url);
  assert.equal(status.workflow, "ci");
  assert.equal(status.commit, "abc123");
  assert.ok(status.checkedAt);
  assert.match(status.reason, /ci succeeded/);
});

ghTest("ci: a failed run is a fail with the workflow named", (t) => {
  const dir = root(t);
  fakeGh(t, [{ ...PASS[0], conclusion: "failure" }]);
  const status = ciStatus(dir, "abc123");
  assert.equal(status.state, "fail");
  assert.match(status.reason, /ci concluded failure/);
});

ghTest("ci: an in-progress run is running", (t) => {
  const dir = root(t);
  fakeGh(t, [{ ...PASS[0], status: "in_progress", conclusion: "" }]);
  assert.equal(ciStatus(dir, "abc123").state, "running");
});

ghTest("ci: no workflow run for the commit is unknown, not a failure", (t) => {
  const dir = root(t);
  fakeGh(t, []);
  const status = ciStatus(dir, "abc123");
  assert.equal(status.state, "unknown");
  assert.match(status.reason, /no workflow run/);
});

test("ci: missing gh is unknown with a next step", (t) => {
  const dir = root(t);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const restore = saveEnv(["PATH"]);
  process.env.PATH = empty;
  t.after(restore);
  const status = ciStatus(dir, "abc123");
  assert.equal(status.state, "unknown");
  assert.match(status.reason, /not installed/);
  assert.equal(status.url, null);
});

ghTest("ci: an unauthenticated gh is unknown with a login hint", (t) => {
  const dir = root(t);
  fakeGh(t, [], { exit: 1, stderr: "To get started with GitHub CLI, please run: gh auth login" });
  const status = ciStatus(dir, "abc123");
  assert.equal(status.state, "unknown");
  assert.match(status.reason, /not authenticated/);
  assert.match(status.reason, /gh auth login/);
});

ghTest("ci: a commit is cached for the TTL and refreshed after it", (t) => {
  const dir = root(t);
  const gh = fakeGh(t, PASS);
  assert.equal(ciStatus(dir, "abc123").state, "pass");
  assert.equal(gh.calls().length, 1);

  gh.respond([{ ...PASS[0], conclusion: "failure" }]);
  const cached = ciStatus(dir, "abc123");
  assert.equal(cached.state, "pass");
  assert.equal(cached.cached, true, "the cached answer is labelled");
  assert.equal(gh.calls().length, 1, "no second gh call inside the TTL");

  const refreshed = ciStatus(dir, "abc123", { ttlMs: 0 });
  assert.equal(refreshed.state, "fail");
  assert.equal(gh.calls().length, 2);
});

ghTest("ci: the cache lives in .ratchet and ignores itself", (t) => {
  const dir = root(t);
  fakeGh(t, PASS);
  ciStatus(dir, "abc123");
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "ci-cache.json")), true);
  const ignore = fs.readFileSync(path.join(dir, ".ratchet", ".gitignore"), "utf8");
  assert.match(ignore, /ci-cache\.json/);
});

test("ci: commitForRun prefers the closing HEAD, then the contract base", (t) => {
  const dir = root(t);
  runFixture(dir, "run-a", { baseCommit: "base-a" }, { git: { head: "closed-a" } });
  assert.equal(commitForRun(dir, { id: "run-a", baseCommit: "base-a" }), "closed-a");

  runFixture(dir, "run-b", { baseCommit: "base-b" });
  assert.equal(commitForRun(dir, { id: "run-b", baseCommit: "base-b" }), "base-b");
});

ghTest("ci CLI: prints HEAD status when there is no run", (t) => {
  const dir = root(t);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  const gh = fakeGh(t, PASS);
  const result = spawnSync(process.execPath, [BIN, "ci", "--json"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.state, "pass");
  assert.equal(parsed.run, null);
  assert.equal(parsed.commit.length, 40);
  assert.equal(gh.calls().length, 1);
});

ghTest("ci CLI: a failed run exits 1 and names the log command", (t) => {
  const dir = root(t);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  fakeGh(t, [{ ...PASS[0], conclusion: "failure" }]);
  const result = spawnSync(process.execPath, [BIN, "ci"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CI .* fail/);
  assert.match(result.stdout, /gh run view 42 --log-failed/);
});

ghTest("ci: evidence --ci and digest --ci attach the run's status", (t) => {
  const dir = root(t);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  runFixture(
    dir,
    "20260101-ci",
    { baseCommit: head, createdAt: "2026-01-01T00:00:00.000Z" },
    { verdict: "done", git: { head } },
  );
  fs.writeFileSync(
    path.join(dir, ".ratchet", "runs", "20260101-ci", "checks.json"),
    JSON.stringify({ ok: true, ranAt: "2026-01-01T00:00:00.000Z", results: [] }),
  );
  const gh = fakeGh(t, PASS);

  const evidence = spawnSync(
    process.execPath,
    [BIN, "evidence", "--run", "20260101-ci", "--ci", "--json"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(evidence.status, 0, evidence.stderr);
  const parsed = JSON.parse(evidence.stdout);
  assert.equal(parsed.ci.recorded, true);
  assert.equal(parsed.ci.state, "pass");
  assert.equal(parsed.ci.commit, head);
  assert.equal(gh.calls().length, 1);

  const digest = spawnSync(process.execPath, [BIN, "digest", "--ci", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  const parsedDigest = JSON.parse(digest.stdout);
  assert.equal(parsedDigest.ci.run, "20260101-ci");
  assert.equal(parsedDigest.ci.status.state, "pass");
  assert.equal(gh.calls().length, 1, "the second command reads the cache");
});
