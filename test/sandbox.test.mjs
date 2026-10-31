import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createContract, defaultConfig, saveConfig, saveContract } from "../lib/contract.mjs";
import { eventsPath } from "../lib/contract.mjs";
import { decide, record } from "../lib/decide.mjs";
import { readJsonl } from "../lib/fsx.mjs";
import {
  buildProfile,
  detectSandbox,
  isControlPlaneCommand,
  quote,
  runSandboxed,
  staticPrefix,
  wrapCommand,
  writeRoots,
} from "../lib/sandbox.mjs";
import { windowsOnly } from "./helpers.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const DETECTED = detectSandbox();
const SEATBELT_PROBE =
  process.platform === "darwin" && DETECTED.backend === "seatbelt"
    ? spawnSync(DETECTED.bin, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], { encoding: "utf8" })
    : null;
const SEATBELT_SKIP =
  process.platform === "darwin" && DETECTED.backend === "seatbelt"
    ? SEATBELT_PROBE?.status === 0
      ? false
      : `seatbelt cannot run here (nested sandbox or unavailable): ${(SEATBELT_PROBE?.stderr || "").trim()}`
    : "seatbelt backend unavailable on this machine";

function tempDir(t, prefix = "ratchet-sandbox-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repoDir(t, prefix = ".ratchet-sandbox-cli-") {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, "..", prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function configuredRepo(t, sandbox = { enabled: true }) {
  const root = tempDir(t);
  const config = defaultConfig(root);
  config.sandbox = sandbox;
  saveConfig(root, config);
  return root;
}

function liveContract(root, opts = {}) {
  const contract = createContract(root, {
    goal: "sandbox test",
    role: "coder",
    scope: ["src/**"],
    maxFiles: 50,
    maxWrites: 50,
    ...opts,
  });
  saveContract(root, contract);
  return contract;
}

const fakeSeatbelt = () => ({ backend: "seatbelt", bin: "/usr/bin/sandbox-exec", reason: "test backend" });
const noBackend = () => ({ backend: null, bin: null, reason: "no backend for this test" });

/**
 * How an SBPL string literal spells a path. Backslashes are doubled, so a
 * Windows path in a profile is not the plain path. On POSIX this is identity.
 */
const sbpl = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// --- detection --------------------------------------------------------------

test("sandbox: macOS without sandbox-exec reports no backend and why", () => {
  const result = detectSandbox({ platform: "darwin", exists: () => false });
  assert.equal(result.backend, null);
  assert.match(result.reason, /sandbox-exec/);
});

test("sandbox: linux without bwrap reports no backend and why", () => {
  const result = detectSandbox({ platform: "linux", which: () => null });
  assert.equal(result.backend, null);
  assert.match(result.reason, /bwrap/);
});

test("sandbox: linux reports bwrap when it is on PATH", () => {
  const result = detectSandbox({ platform: "linux", which: (name) => (name === "bwrap" ? "/usr/bin/bwrap" : null) });
  assert.equal(result.backend, "bwrap");
  assert.equal(result.bin, "/usr/bin/bwrap");
});

test("sandbox: an unsupported platform never guesses", () => {
  const result = detectSandbox({ platform: "freebsd" });
  assert.equal(result.backend, null);
  assert.match(result.reason, /unsupported platform/);
});

test(
  "sandbox: native Windows reports no backend and points at WSL2 or CI",
  { skip: windowsOnly("no native Windows write fence") },
  () => {
    const result = detectSandbox({ which: () => null });
    assert.equal(result.backend, null);
    assert.match(result.reason, /WSL2/i);
    assert.match(result.reason, /CI|continuous integration/i);
  },
);

// --- profile ----------------------------------------------------------------

test("sandbox: a glob becomes its static directory prefix", () => {
  const root = "/repo";
  assert.equal(staticPrefix(root, "**"), root);
  assert.equal(staticPrefix(root, "src/**"), path.join(root, "src"));
  assert.equal(staticPrefix(root, "src/*.mjs"), path.join(root, "src"));
  assert.equal(staticPrefix(root, "src/deep/*.ts"), path.join(root, "src", "deep"));
  assert.equal(staticPrefix(root, "LAWS.bend"), root);
  assert.equal(staticPrefix(root, "../escape/**"), root);
});

test("sandbox: the profile allows reads, denies writes, and reopens only the fence", (t) => {
  const root = tempDir(t);
  const profile = buildProfile(
    root,
    { scope: ["src/**", "docs/*.md"] },
    {
      home: path.join(root, "home"),
      tempRoots: ["/tmp"],
      cacheRoots: [path.join(root, "home", ".npm")],
    },
  );

  assert.match(profile, /^\(version 1\)/);
  assert.match(profile, /^\(allow default\)$/m);
  assert.match(profile, /^\(deny file-write\*\)$/m);
  assert.ok(profile.includes(`(subpath "${sbpl(path.join(root, "src"))}")`), profile);
  assert.ok(profile.includes(`(subpath "${sbpl(path.join(root, "docs"))}")`), profile);
  assert.ok(profile.includes(`(subpath "${sbpl(path.join(root, ".git"))}")`), profile);
  assert.ok(profile.includes(`(subpath "${sbpl(path.join(root, "home", ".npm"))}")`), profile);
  assert.ok(profile.includes(`(literal "/dev/null")`), profile);
});

test("sandbox: buildProfile is deterministic", (t) => {
  const root = tempDir(t);
  const options = { home: path.join(root, "home"), tempRoots: ["/tmp"], cacheRoots: [] };
  const once = buildProfile(root, { scope: ["src/**", "lib/**"] }, options);
  const twice = buildProfile(root, { scope: ["lib/**", "src/**"] }, options);
  assert.equal(once, twice);
});

test("sandbox: ** opens the repo root, and only the root", (t) => {
  const root = tempDir(t);
  const { dirs } = writeRoots(root, { scope: ["**"] }, { home: "", tempRoots: [], cacheRoots: [] });
  assert.ok(dirs.includes(root));
  assert.ok(dirs.includes(path.join(root, ".git")));
});

test("sandbox: a read-only contract does not open its scope", (t) => {
  const root = tempDir(t);
  const { dirs } = writeRoots(
    root,
    { scope: ["**"], readOnly: true },
    { home: "", tempRoots: [], cacheRoots: [] },
  );
  assert.ok(!dirs.includes(root));
  assert.ok(dirs.includes(path.join(root, ".git")));
});

test("sandbox: guard state stays denied even under **", (t) => {
  const root = tempDir(t);
  const profile = buildProfile(root, { scope: ["**"] }, { home: "", tempRoots: [], cacheRoots: [] });
  assert.ok(
    profile.includes(`(deny file-write* (literal "${sbpl(path.join(root, ".ratchet", "current"))}")`),
    profile,
  );
  assert.ok(
    profile.includes(`(deny file-write* (subpath "${sbpl(path.join(root, ".ratchet", "runs"))}")`),
    profile,
  );
});

test("sandbox: a glob never widens past the repo root", (t) => {
  const root = tempDir(t);
  const { dirs } = writeRoots(root, { scope: ["../outside/**"] }, { home: "", tempRoots: [], cacheRoots: [] });
  assert.ok(dirs.includes(root));
  assert.ok(!dirs.includes(path.join(path.dirname(root), "outside")));
});

// --- command construction ---------------------------------------------------

test("sandbox: quote is POSIX safe", () => {
  assert.equal(quote("plain"), "plain");
  assert.equal(quote("two words"), "'two words'");
  assert.equal(quote("it's"), "'it'\\''s'");
  assert.equal(quote(""), "''");
});

test("sandbox: wrapCommand fails closed without a backend", () => {
  assert.throws(() => wrapCommand("echo x", { backend: null, enforce: true }), /sandbox unavailable/);
});

test("sandbox: wrapCommand can produce an advisory plain command", () => {
  const wrapped = wrapCommand("echo x", { backend: null, enforce: false, profile: "(version 1)" });
  assert.equal(wrapped.enforced, false);
  assert.equal(wrapped.backend, null);
  assert.deepEqual(wrapped.argv, ["/bin/sh", "-c", "echo x"]);
});

test("sandbox: seatbelt argv keeps each argument separate", () => {
  const wrapped = wrapCommand("echo 'hi there'", {
    backend: "seatbelt",
    bin: "/usr/bin/sandbox-exec",
    profile: "(version 1)",
  });
  assert.deepEqual(wrapped.argv, [
    "/usr/bin/sandbox-exec",
    "-p",
    "(version 1)",
    "/bin/sh",
    "-c",
    "echo 'hi there'",
  ]);
  assert.equal(wrapped.enforced, true);
  assert.match(wrapped.command, /^\/usr\/bin\/sandbox-exec -p '/);
});

test("sandbox: bwrap binds the fence roots and chdirs", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const wrapped = wrapCommand("echo x", {
    backend: "bwrap",
    bin: "/usr/bin/bwrap",
    root,
    contract: { scope: ["src/**"] },
    cwd: root,
    home: "",
    tempRoots: [],
    cacheRoots: [],
  });
  assert.equal(wrapped.argv[0], "/usr/bin/bwrap");
  assert.ok(wrapped.argv.includes("--ro-bind"));
  assert.ok(wrapped.argv.includes("--chdir"));
  assert.ok(wrapped.argv.includes(path.join(root, "src")));
  assert.ok(wrapped.argv.includes(path.join(root, ".git")));
});

test("sandbox: the control plane is recognised, a compound command is not", () => {
  for (const command of ["ratchet check", "cd /repo && ratchet done", "ratchet amend --reason x"]) {
    assert.equal(isControlPlaneCommand(command), true, command);
  }
  for (const command of [
    "npm test",
    "ratchet check && rm -rf src",
    "echo x; ratchet check",
    "cd /repo && ratchet check; echo x",
    "cd /repo && npm test",
    "ratchet task status",
    "ratchet run -- npm test",
    "ratchet hook",
  ]) {
    assert.equal(isControlPlaneCommand(command), false, command);
  }
});

// --- decide integration -----------------------------------------------------

test("decide: sandbox is off unless config.sandbox.enabled is true", (t) => {
  const root = tempDir(t);
  const config = defaultConfig(root);
  saveConfig(root, config);
  liveContract(root);
  const decision = decide(root, { harness: "opencode", tool: "bash", input: { command: "echo x > src/a.ts" } });
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox, undefined);
});

test("decide: an OpenCode bash call gets an enforced seatbelt command", (t) => {
  const root = configuredRepo(t);
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "bash", input: { command: "echo x > src/a.ts" } },
    { sandboxDetect: fakeSeatbelt },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox.enforced, true);
  assert.equal(decision.sandbox.backend, "seatbelt");
  assert.match(decision.sandbox.command, /^\/usr\/bin\/sandbox-exec -p /);
  assert.match(decision.sandbox.profile, /\(deny file-write\*\)/);
  assert.ok(decision.sandbox.profile.includes(sbpl(path.join(root, "src"))));
});

test("decide: a read-only bash call is fenced too", (t) => {
  const root = configuredRepo(t);
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "bash", input: { command: "git status --porcelain" } },
    { sandboxDetect: fakeSeatbelt },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.op, "read");
  assert.equal(decision.sandbox.enforced, true);
});

test("decide: a harness that cannot rewrite gets advisory metadata, not enforcement", (t) => {
  const root = configuredRepo(t);
  liveContract(root);
  const decision = decide(
    root,
    { harness: "claude", tool: "bash", input: { command: "echo x > src/a.ts" } },
    { sandboxDetect: fakeSeatbelt },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox.enforced, false);
  assert.match(decision.sandbox.reason, /cannot rewrite/);
  assert.ok(decision.sandbox.profile);
});

test("decide: a required fence with no backend fails closed", (t) => {
  const root = configuredRepo(t, { enabled: true, required: true });
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "bash", input: { command: "git status" } },
    { sandboxDetect: noBackend },
  );
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /Sandbox required but unavailable/);
  assert.equal(decision.op, "write");
});

test("decide: an unavailable fence without required stays advisory", (t) => {
  const root = configuredRepo(t);
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "bash", input: { command: "git status" } },
    { sandboxDetect: noBackend },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox.available, false);
  assert.equal(decision.sandbox.enforced, false);
});

test("decide: the control plane still runs when the fence is required but unavailable", (t) => {
  const root = configuredRepo(t, { enabled: true, required: true });
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "bash", input: { command: "ratchet check" } },
    { sandboxDetect: noBackend },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox.enforced, false);
  assert.match(decision.sandbox.reason, /control-plane/);
});

test("decide: a required fence denies a harness that cannot rewrite", (t) => {
  const root = configuredRepo(t, { enabled: true, required: true });
  liveContract(root);
  const decision = decide(
    root,
    { harness: "claude", tool: "bash", input: { command: "git status" } },
    { sandboxDetect: fakeSeatbelt },
  );
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /cannot rewrite/);
});

test("decide: a bare ratchet control command is not wrapped", (t) => {
  const root = configuredRepo(t);
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "bash", input: { command: "cd . && ratchet check" } },
    { sandboxDetect: fakeSeatbelt },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox.enforced, false);
  assert.match(decision.sandbox.reason, /control-plane/);
});

test("decide: a compound ratchet command is wrapped", (t) => {
  const root = configuredRepo(t);
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "bash", input: { command: "ratchet check; echo x > src/a.ts" } },
    { sandboxDetect: fakeSeatbelt },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox.enforced, true);
});

test("decide: a write tool is never sandboxed", (t) => {
  const root = configuredRepo(t);
  liveContract(root);
  const decision = decide(
    root,
    { harness: "opencode", tool: "write", input: { path: "src/a.ts" } },
    { sandboxDetect: fakeSeatbelt },
  );
  assert.equal(decision.allow, true);
  assert.equal(decision.sandbox, undefined);
});

test("decide: the event trail records the backend and whether it was enforced", (t) => {
  const root = configuredRepo(t);
  const contract = liveContract(root);
  const event = { harness: "opencode", tool: "bash", input: { command: "echo x > src/a.ts" } };
  const decision = decide(root, event, { sandboxDetect: fakeSeatbelt });
  record(root, { ...event, session_id: null, harness: "opencode" }, decision);
  const rows = readJsonl(eventsPath(root, contract.id));
  const last = rows.at(-1);
  assert.equal(last.sandbox.backend, "seatbelt");
  assert.equal(last.sandbox.enforced, true);
});

// --- real kernel ------------------------------------------------------------

test("sandbox: seatbelt allows an in-scope write and denies an out-of-scope write", { skip: SEATBELT_SKIP }, (t) => {
  const base = tempDir(t);
  const root = path.join(base, "repo");
  const inside = path.join(root, "src");
  fs.mkdirSync(inside, { recursive: true });
  const contract = { scope: ["src/**"] };
  const profile = buildProfile(root, contract, {
    home: path.join(base, "home"),
    tempRoots: [],
    cacheRoots: [],
  });

  const inFile = path.join(inside, "ok.txt");
  const inResult = runSandboxed(`echo ok > ${quote(inFile)}`, {
    backend: "seatbelt",
    bin: DETECTED.bin,
    profile,
    root,
    contract,
    cwd: root,
  });
  assert.equal(inResult.status, 0, inResult.stderr);
  assert.equal(fs.readFileSync(inFile, "utf8").trim(), "ok");

  const outFile = path.join(base, "leak.txt");
  const outResult = runSandboxed(`echo bad > ${quote(outFile)}`, {
    backend: "seatbelt",
    bin: DETECTED.bin,
    profile,
    root,
    contract,
    cwd: root,
  });
  assert.notEqual(outResult.status, 0);
  assert.equal(fs.existsSync(outFile), false);

  // A `**` contract opens the repo root, but guard state stays closed.
  const broad = buildProfile(root, { scope: ["**"] }, {
    home: path.join(base, "home"),
    tempRoots: [],
    cacheRoots: [],
  });
  const guardFile = path.join(root, ".ratchet", "current");
  fs.mkdirSync(path.dirname(guardFile), { recursive: true });
  const guardResult = runSandboxed(`echo x > ${quote(guardFile)}`, {
    backend: "seatbelt",
    bin: DETECTED.bin,
    profile: broad,
    root,
    contract: { scope: ["**"] },
    cwd: root,
  });
  assert.notEqual(guardResult.status, 0);
  assert.equal(fs.existsSync(guardFile), false);

  const topFile = path.join(root, "top.txt");
  const topResult = runSandboxed(`echo top > ${quote(topFile)}`, {
    backend: "seatbelt",
    bin: DETECTED.bin,
    profile: broad,
    root,
    contract: { scope: ["**"] },
    cwd: root,
  });
  assert.equal(topResult.status, 0, topResult.stderr);
  assert.equal(fs.readFileSync(topFile, "utf8").trim(), "top");

  const devnull = runSandboxed("echo devnull > /dev/null", {
    backend: "seatbelt",
    bin: DETECTED.bin,
    profile,
    root,
    contract,
    cwd: root,
  });
  assert.equal(devnull.status, 0, devnull.stderr);
});

test("sandbox: runSandboxed refuses to run without a backend", () => {
  const result = runSandboxed("echo x", { backend: null, enforce: true });
  assert.equal(result.status, 126);
  assert.equal(result.backend, null);
  assert.match(result.stderr, /sandbox unavailable/);
});

// --- CLI --------------------------------------------------------------------

test("cli: ratchet sandbox runs a command through the live contract profile", { skip: SEATBELT_SKIP }, (t) => {
  const base = repoDir(t);
  const root = path.join(base, "repo");
  fs.mkdirSync(root, { recursive: true });
  const init = spawnSync(process.execPath, [BIN, "init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const start = spawnSync(
    process.execPath,
    [BIN, "task", "start", "--role", "coder", "--goal", "sandbox cli", "--scope", "src/**", "--verify", "node --version"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(start.status, 0, start.stderr);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });

  const scripts = tempDir(t, "ratchet-sandbox-scripts-");
  const inScript = path.join(scripts, "in.sh");
  const outScript = path.join(scripts, "out.sh");
  const inFile = path.join(root, "src", "from-cli.txt");
  const outFile = path.join(root, "outside.txt");
  fs.writeFileSync(inScript, `echo ok > ${quote(inFile)}\n`);
  fs.writeFileSync(outScript, `echo bad > ${quote(outFile)}\n`);

  const inside = spawnSync(process.execPath, [BIN, "sandbox", "--", "sh", inScript], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(fs.readFileSync(inFile, "utf8").trim(), "ok");

  const outside = spawnSync(process.execPath, [BIN, "sandbox", "--", "sh", outScript], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(outside.status, 0);
  assert.equal(fs.existsSync(outFile), false);

  const status = spawnSync(process.execPath, [BIN, "status"], { cwd: root, encoding: "utf8" });
  assert.match(status.stdout, /sandbox: seatbelt \(write fence available\)/);

  const configFile = path.join(root, ".ratchet", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.sandbox = { enabled: true, required: false };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const doctor = spawnSync(process.execPath, [BIN, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(doctor.stdout, /sandbox\s+seatbelt/);
  assert.match(doctor.stdout, /sandbox adapter rewrite/);
});
