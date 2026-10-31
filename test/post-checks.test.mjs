import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPostChecks, targetsFor } from "../lib/post-checks.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-post-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".ratchet"), { recursive: true });
  writeConfig(root, { version: 1, checks: [], post: [] });
  return root;
}

function writeConfig(root, config) {
  fs.writeFileSync(path.join(root, ".ratchet", "config.json"), JSON.stringify(config, null, 2));
}

function toolAfter(root, tool, input) {
  return {
    type: "tool.after",
    harness: "test",
    session_id: "s-1",
    cwd: root,
    tool,
    input,
    result: { exit: 0 },
  };
}

function source(root, files) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(root, file), "export const a = 1\n");
}

function ratchet(root, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, input, encoding: "utf8" });
}

test("post checks: {files} receives the changed path and failure context", (t) => {
  const root = repo(t);
  source(root, ["src/a.ts"]);
  fs.writeFileSync(
    path.join(root, "lint.mjs"),
    [
      'import fs from "node:fs";',
      'const files = process.argv.slice(2);',
      'fs.appendFileSync("lint.log", files.join(" ") + "\\n");',
      'console.error("lint failed: " + files.join(" "));',
      "process.exit(1);",
      "",
    ].join("\n"),
  );

  const config = { version: 1, post: [{ id: "lint", cmd: "node lint.mjs {files}" }] };
  const result = runPostChecks(root, toolAfter(root, "write", { path: "src/a.ts" }), config);

  assert.deepEqual(result.targets, ["src/a.ts"]);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].id, "lint");
  assert.equal(result.results[0].status, 1);
  assert.equal(fs.readFileSync(path.join(root, "lint.log"), "utf8").trim(), "src/a.ts");
  assert.match(result.context, /post checks failed: lint/);
  assert.match(result.context, /lint failed: src\/a\.ts/);
});

test("post checks: a passing command returns a null context", (t) => {
  const root = repo(t);
  source(root, ["src/a.ts"]);
  fs.writeFileSync(path.join(root, "lint.mjs"), "process.exit(0)\n");

  const config = { version: 1, post: [{ id: "lint", cmd: "node lint.mjs {files}" }] };
  const result = runPostChecks(root, toolAfter(root, "write", { path: "src/a.ts" }), config);

  assert.equal(result.ok, true);
  assert.equal(result.context, null);
  assert.deepEqual(result.targets, ["src/a.ts"]);
  assert.deepEqual(result.results.map((r) => r.status), [0]);
});

test("post checks: no post config is a no-op", (t) => {
  const root = repo(t);
  source(root, ["src/a.ts"]);
  fs.writeFileSync(path.join(root, "marker.mjs"), 'import fs from "node:fs";\nfs.writeFileSync("ran", "yes");\n');

  const result = runPostChecks(root, toolAfter(root, "write", { path: "src/a.ts" }), { version: 1, checks: [] });

  assert.equal(result.ok, true);
  assert.equal(result.context, null);
  assert.deepEqual(result.results, []);
  assert.equal(fs.existsSync(path.join(root, "ran")), false);
});

test("post checks: a command without {files} runs once per batch", (t) => {
  const root = repo(t);
  source(root, ["src/a.ts", "src/b.ts"]);
  fs.writeFileSync(path.join(root, "count.mjs"), 'import fs from "node:fs";\nfs.appendFileSync("ran.log", "x\\n");\n');

  const config = { version: 1, post: [{ id: "batch", cmd: "node count.mjs" }] };
  const result = runPostChecks(
    root,
    toolAfter(root, "write", { files: ["src/a.ts", "src/b.ts"] }),
    config,
  );

  assert.deepEqual(result.targets, ["src/a.ts", "src/b.ts"]);
  assert.equal(fs.readFileSync(path.join(root, "ran.log"), "utf8").trim(), "x");
  assert.equal(result.results.length, 1);
});

test("post checks: bash touch is detected through git status", (t) => {
  const root = repo(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  // Do the write in Node: `touch` does not exist on native Windows, and the
  // point of the fixture is a file that git status sees, not the command.
  fs.writeFileSync(path.join(root, "src", "a.ts"), "");

  const targets = targetsFor(root, toolAfter(root, "bash", { command: "touch src/a.ts" }));
  assert.deepEqual(targets, ["src/a.ts"]);
});

test("post checks: paths outside the repo and non-code files are ignored", (t) => {
  const root = repo(t);
  source(root, ["src/a.ts"]);
  fs.writeFileSync(path.join(root, "notes.txt"), "hi\n");

  const targets = targetsFor(
    root,
    toolAfter(root, "write", { files: ["src/a.ts", "notes.txt", "../outside.ts", "src/missing.ts"] }),
  );
  assert.deepEqual(targets, ["src/a.ts"]);
});

test("post checks: ratchet hook feeds failures back and stop still runs the full verify", (t) => {
  const root = repo(t);
  fs.rmSync(path.join(root, ".ratchet", "config.json"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "post", scripts: { check: 'node -e "process.exit(0)"' } }, null, 2),
  );
  assert.equal(ratchet(root, ["init"]).status, 0);

  const config = {
    version: 1,
    checks: [{ id: "check", cmd: 'node -e "process.exit(0)"' }],
    post: [{ id: "lint", cmd: "node lint.mjs {files}" }],
  };
  writeConfig(root, config);
  fs.writeFileSync(path.join(root, "lint.mjs"), 'console.error("lint failed");\nprocess.exit(1);\n');
  source(root, ["src/a.ts"]);

  const start = ratchet(root, [
    "task", "start",
    "--role", "coder",
    "--goal", "post checks",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(start.status, 0, start.stderr);

  const event = (type, extra = {}) => JSON.stringify({ type, harness: "test", session_id: "s-1", cwd: root, ...extra });
  const after = ratchet(
    root,
    ["hook"],
    event("tool.after", { tool: "write", input: { path: "src/a.ts" }, result: { exit: 0 } }),
  );
  assert.equal(after.status, 0, after.stderr);
  const decision = JSON.parse(after.stdout);
  assert.equal(decision.continue, true);
  assert.match(decision.context, /post checks failed: lint/);
  assert.match(decision.context, /lint failed/);

  const cert = ratchet(root, ["hook"], event("turn.stop"));
  assert.equal(cert.status, 0, cert.stderr);
  assert.equal(JSON.parse(cert.stdout).certified, true);

  const id = fs.readFileSync(path.join(root, ".ratchet", "current"), "utf8").trim();
  const checks = JSON.parse(fs.readFileSync(path.join(root, ".ratchet", "runs", id, "checks.json"), "utf8"));
  assert.equal(checks.ok, true);
  assert.deepEqual(checks.results.map((r) => [r.id, r.status]), [["verify-1", 0]]);
});
