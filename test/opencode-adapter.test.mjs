import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const ADAPTER = path.join(import.meta.dirname, "..", "adapters", "opencode", "ratchet.js");

const loaded = await import(pathToFileURL(ADAPTER).href).then(
  (module) => ({ adapter: module.default }),
  (error) => ({ error }),
);
const skipped = loaded.error
  ? `opencode adapter cannot be imported under Node ${process.version}: ${loaded.error.message}`
  : false;

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-opencode-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-opencode-bin-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "opencode-adapter", private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2),
  );
  const shim = path.join(bin, "ratchet");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  process.env.RATCHET_BIN = shim;
  return dir;
}

function ratchet(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

function start(dir) {
  const result = ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "opencode adapter",
    "--scope", "src/**",
    "--verify", 'node -e "process.exit(0)"',
  ]);
  assert.equal(result.status, 0, result.stderr);
}

async function harness(dir, opts = {}) {
  const handlers = new Map();
  await loaded.adapter.setup({
    location: { directory: opts.location ?? dir },
    tool: {
      hook(name, handler) {
        handlers.set(name, handler);
      },
    },
  });
  return {
    before(event) {
      const handler = handlers.get("execute.before");
      assert.ok(handler, "execute.before registered");
      return handler({ sessionID: "oc-session", ...event });
    },
    after(event) {
      const handler = handlers.get("execute.after");
      assert.ok(handler, "execute.after registered");
      return handler({ sessionID: "oc-session", ...event });
    },
  };
}

test("opencode adapter: before denies outside scope and allows inside", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);
  const adapter = await harness(dir);

  assert.throws(
    () => adapter.before({ tool: "write", input: { path: "outside.txt", content: "leak" } }),
    /outside scope/,
  );
  assert.equal(adapter.before({ tool: "write", input: { path: "src/a.ts", content: "ok" } }), undefined);
  assert.equal(adapter.before({ tool: "read", input: { path: "README.md" } }), undefined);
});

test("opencode adapter: after throws post-check context", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);
  const configFile = path.join(dir, ".ratchet", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.post = [{ id: "lint", cmd: "node lint.mjs {files}" }];
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, "lint.mjs"), 'console.error("lint failed: " + process.argv.slice(2).join(" "));\nprocess.exit(1);\n');
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1\n");
  const adapter = await harness(dir);

  assert.throws(
    () =>
      adapter.after({
        tool: "write",
        input: { path: "src/a.ts" },
        result: { ok: true },
      }),
    /post checks failed: lint/,
  );
});

test("opencode adapter: no-ops outside a contract", { skip: skipped }, async (t) => {
  const dir = repo(t);
  const adapter = await harness(dir);
  assert.equal(adapter.before({ tool: "write", input: { path: "x.txt" } }), undefined);
  assert.equal(adapter.after({ tool: "write", input: { path: "x.txt" }, result: { ok: true } }), undefined);
});

test("opencode adapter: resolves the repo from the target when the session is elsewhere", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);
  // T3 Code hosts every thread in one instance rooted at the app workspace,
  // not the project. A call aimed at an absolute path must still find the repo.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-opencode-elsewhere-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const adapter = await harness(elsewhere, { location: elsewhere });

  assert.equal(
    adapter.before({ tool: "write", input: { filePath: path.join(dir, "src/a.ts") } }),
    undefined,
  );
  assert.throws(
    () => adapter.before({ tool: "write", input: { filePath: path.join(dir, "outside.txt") } }),
    /outside scope/,
  );
});

test("opencode adapter: an idle ratchet repo denies writes, allows read-only bash", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const adapter = await harness(dir);
  assert.throws(
    () => adapter.before({ tool: "write", input: { path: "src/a.ts" } }),
    /No active task contract/,
  );
  assert.equal(adapter.before({ tool: "bash", input: { command: "git status --porcelain" } }), undefined);
});

test("opencode adapter: task start is allowed when idle, denied with a live contract", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  const idle = await harness(dir);
  assert.equal(
    idle.before({ tool: "bash", input: { command: 'ratchet task start --goal "x" --scope "**"' } }),
    undefined,
  );

  start(dir);
  const live = await harness(dir);
  assert.throws(
    () => live.before({ tool: "bash", input: { command: 'ratchet task start --force --goal "y" --scope "**"' } }),
    /guard-state mutation/,
  );
});

test("opencode adapter: disable allows writes until enable", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);
  const adapter = await harness(dir);

  assert.throws(() => adapter.before({ tool: "write", input: { path: "outside.txt" } }), /outside scope/);
  assert.equal(ratchet(dir, ["disable", "--reason", "adapter test"]).status, 0);
  assert.match(ratchet(dir, ["status"]).stdout, /DISABLED/);
  assert.equal(adapter.before({ tool: "write", input: { path: "outside.txt" } }), undefined);
  assert.equal(ratchet(dir, ["enable"]).status, 0);
  assert.throws(() => adapter.before({ tool: "write", input: { path: "outside.txt" } }), /outside scope/);
});

test("opencode adapter: a broken ratchet binary fails closed", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);
  const adapter = await harness(dir);
  const previous = process.env.RATCHET_BIN;
  process.env.RATCHET_BIN = "/nonexistent/ratchet";
  try {
    assert.throws(() => adapter.before({ tool: "write", input: { path: "src/a.ts" } }), /cannot run/);
  } finally {
    process.env.RATCHET_BIN = previous;
  }
});

test("opencode adapter: a crashing ratchet binary fails closed", { skip: skipped }, async (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  start(dir);
  const adapter = await harness(dir);
  const previous = process.env.RATCHET_BIN;
  const crash = path.join(path.dirname(previous), "ratchet-crash");
  fs.writeFileSync(crash, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(crash, 0o755);
  process.env.RATCHET_BIN = crash;
  try {
    assert.throws(() => adapter.before({ tool: "write", input: { path: "src/a.ts" } }), /guard exited 1|without a decision/);
  } finally {
    process.env.RATCHET_BIN = previous;
    fs.rmSync(crash, { force: true });
  }
});
