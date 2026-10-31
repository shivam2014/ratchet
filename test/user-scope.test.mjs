import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function userHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-user-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

function envFor(home) {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function ratchet(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    env: envFor(home),
    encoding: "utf8",
  });
}

function hookAt(cwd, writePath) {
  return spawnSync(process.execPath, [BIN, "hook"], {
    cwd,
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd },
    encoding: "utf8",
    input: JSON.stringify({
      type: "tool.before",
      harness: "test",
      session_id: "user-scope",
      tool: "write",
      input: { path: writePath },
      cwd,
    }),
  });
}

function hook(home, writePath) {
  return hookAt(home, writePath);
}

test("user scope: task start --user creates a home contract with a narrow scope", (t) => {
  const home = userHome(t);
  const started = ratchet(home, [
    "task", "start", "--user",
    "--role", "coder",
    "--goal", "install user tools",
    "--scope", "~/bin/**",
    "--verify", "node --version",
  ]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(fs.existsSync(path.join(home, ".ratchet", "config.json")), true);

  const id = fs.readFileSync(path.join(home, ".ratchet", "current"), "utf8").trim();
  const contract = JSON.parse(fs.readFileSync(path.join(home, ".ratchet", "runs", id, "contract.json"), "utf8"));
  assert.deepEqual(contract.scope, ["bin/**"]);

  const inside = hook(home, path.join(home, "bin", "atlas-mmd"));
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(JSON.parse(inside.stdout).allow, true);

  const outside = hook(home, path.join(home, "elsewhere.txt"));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /outside scope/);
});

test("user scope: a non-user contract cannot write outside its repo", (t) => {
  const home = userHome(t);
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "repo", private: true }));
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: repo },
  );
  assert.equal(ratchet(repo, ["init"]).status, 0);
  const started = ratchet(repo, [
    "task", "start",
    "--role", "coder",
    "--goal", "repo only",
    "--scope", "**",
    "--verify", "node --version",
  ]);
  assert.equal(started.status, 0, started.stderr);

  const outside = hookAt(repo, path.join(os.homedir(), `.ratchet-user-outside-${process.pid}.txt`));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /outside scope/);
});
