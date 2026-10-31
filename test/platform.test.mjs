import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isWindows,
  opencodeConfigDir,
  pathIsInside,
  pathKey,
  runShell,
  shellCommand,
  tempRoots,
  which,
} from "../lib/platform.mjs";
import { isInside } from "../lib/fsx.mjs";
import { detectSandbox, WINDOWS_NO_FENCE, wrapCommand } from "../lib/sandbox.mjs";
import { runChecks } from "../lib/checks.mjs";

function tempDir(t, prefix = "ratchet-platform-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function touch(file, content = "", mode = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== null) fs.chmodSync(file, mode);
}

// --- shell ----------------------------------------------------------------

test("platform: POSIX shells are /bin/sh -c on macOS and Linux", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(shellCommand("node --version", { platform }), {
      file: "/bin/sh",
      args: ["-c", "node --version"],
    });
  }
});

test("platform: Windows uses ComSpec with /d /s /c and the whole command", () => {
  const explicit = shellCommand("dir /b", {
    platform: "win32",
    comspec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(explicit, {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "dir /b"],
  });

  const fromEnv = shellCommand("dir", { platform: "win32", env: { ComSpec: "C:\\custom\\cmd.exe" } });
  assert.equal(fromEnv.file, "C:\\custom\\cmd.exe");

  const fallback = shellCommand("dir", { platform: "win32", env: {} });
  assert.deepEqual(fallback, { file: "cmd.exe", args: ["/d", "/s", "/c", "dir"] });
});

test("platform: a POSIX shell can be overridden for a caller", () => {
  assert.deepEqual(shellCommand("echo x", { platform: "linux", shell: "/bin/bash" }), {
    file: "/bin/bash",
    args: ["-c", "echo x"],
  });
});

// --- which ----------------------------------------------------------------

test("platform: which finds a Windows .CMD and prefers PATHEXT order", (t) => {
  const dir = tempDir(t);
  touch(path.join(dir, "deploy.CMD"), "@echo off\n");
  assert.equal(
    which("deploy", { platform: "win32", env: { PATH: dir, PATHEXT: ".EXE;.CMD;.BAT;.COM" } }),
    path.join(dir, "deploy.CMD"),
  );

  touch(path.join(dir, "deploy.EXE"), "");
  assert.equal(
    which("deploy", { platform: "win32", env: { PATH: dir, PATHEXT: ".EXE;.CMD;.BAT;.COM" } }),
    path.join(dir, "deploy.EXE"),
  );

  touch(path.join(dir, "lower.cmd"), "@echo off\n");
  const lower = which("lower", { platform: "win32", env: { PATH: dir, PATHEXT: ".EXE;.CMD" } });
  assert.ok(lower, "found the lowercase .cmd");
  assert.equal(path.basename(lower).toLowerCase(), "lower.cmd");
});

test("platform: which honours PATH order and a case-insensitive Path key", (t) => {
  const first = tempDir(t, "ratchet-platform-first-");
  const second = tempDir(t, "ratchet-platform-second-");
  touch(path.join(second, "runner.BAT"), "@echo off\n");
  touch(path.join(first, "runner.CMD"), "@echo off\n");
  assert.equal(
    which("runner", { platform: "win32", env: { Path: `${first};${second}`, PATHEXT: ".CMD;.BAT" } }),
    path.join(first, "runner.CMD"),
  );
  assert.equal(
    which("runner", { platform: "win32", env: { Path: `${second};${first}`, PATHEXT: ".CMD;.BAT" } }),
    path.join(second, "runner.BAT"),
  );
});

test("platform: which returns null instead of assuming sh on Windows", (t) => {
  const dir = tempDir(t);
  assert.equal(which("missing", { platform: "win32", env: { PATH: dir } }), null);
  assert.equal(which("missing", { platform: "win32", env: {} }), null);
});

test("platform: which scans POSIX PATH for an executable file", (t) => {
  const dir = tempDir(t);
  const tool = path.join(dir, "tool");
  touch(tool, "#!/bin/sh\nexit 0\n", 0o755);
  assert.equal(which("tool", { platform: "linux", env: { PATH: dir } }), tool);

  const plain = path.join(dir, "not-executable");
  touch(plain, "#!/bin/sh\nexit 0\n", 0o644);
  assert.equal(which("not-executable", { platform: "darwin", env: { PATH: dir } }), null);
});

// --- temp roots -----------------------------------------------------------

test("platform: tempRoots includes the POSIX roots and resolves real paths", () => {
  const roots = tempRoots({
    platform: "linux",
    tmpdir: "/tmp",
    env: { TMPDIR: "/tmp", TMP: "/var/tmp", TEMP: "/private/var/tmp" },
  });
  assert.ok(roots.includes(fs.realpathSync.native("/tmp")), roots.join(", "));
  assert.ok(roots.includes(fs.realpathSync.native("/var/tmp")), roots.join(", "));
  assert.equal(new Set(roots).size, roots.length, "roots are deduplicated");
});

test("platform: tempRoots does not invent POSIX roots on Windows", () => {
  const roots = tempRoots({ platform: "win32", tmpdir: "C:\\Temp", env: {} });
  assert.deepEqual(roots, ["C:\\Temp"]);
  assert.ok(!roots.includes("/tmp"));
});

test("platform: tempRoots keeps TMPDIR/TMP/TEMP on Windows", () => {
  const roots = tempRoots({
    platform: "win32",
    tmpdir: "C:\\Temp",
    env: { TMP: "D:\\Scratch", TEMP: "C:\\Temp" },
  });
  assert.deepEqual(roots, ["C:\\Temp", "D:\\Scratch"]);
});

// --- path identity --------------------------------------------------------

test("platform: isWindows only matches win32", () => {
  assert.equal(isWindows("win32"), true);
  assert.equal(isWindows("darwin"), false);
  assert.equal(isWindows("linux"), false);
});

test("platform: pathKey lowercases only on Windows", () => {
  assert.equal(pathKey("C:\\Repo\\A.TS", "win32"), "c:\\repo\\a.ts");
  assert.equal(pathKey("/Repo/A.TS", "linux"), "/Repo/A.TS");
  assert.equal(pathKey("/Repo/A.TS", "darwin"), "/Repo/A.TS");
});

test("platform: pathIsInside is case-insensitive on Windows and exact on POSIX", () => {
  assert.equal(pathIsInside("C:\\Repo", "c:\\repo\\src\\a.ts", "win32"), true);
  assert.equal(pathIsInside("C:\\Repo", "C:\\Repository\\a.ts", "win32"), false);
  assert.equal(pathIsInside("C:\\Repo", "D:\\Repo\\a.ts", "win32"), false);
  assert.equal(pathIsInside("/repo", "/repo/src/a.ts", "linux"), true);
  assert.equal(pathIsInside("/repo", "/Repo/src/a.ts", "linux"), false);
  assert.equal(pathIsInside("/repo", "/repo2/a.ts", "linux"), false);
});

test("fsx: isInside follows the same platform case rules", () => {
  assert.equal(isInside("C:\\Repo", "c:\\repo\\src\\a.ts", "win32"), true);
  assert.equal(isInside("/repo", "/Repo/src/a.ts", "linux"), false);
});

// --- runShell -------------------------------------------------------------

test("platform: runShell runs through the platform shell with cwd and env", (t) => {
  const dir = tempDir(t);
  const result = runShell('node -e "process.stdout.write(process.cwd())"', {
    cwd: dir,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.realpathSync(result.stdout), fs.realpathSync(dir));

  const envResult = runShell('node -e "process.stdout.write(String(process.env.RATCHET)); process.exit(3)"', {
    encoding: "utf8",
    env: { ...process.env, RATCHET: "1" },
  });
  assert.equal(envResult.status, 3);
  assert.equal(envResult.stdout, "1");
});

test("platform: runShell returns the raw spawn error when the shell is missing", () => {
  const result = runShell("echo x", { platform: "linux", shell: "/definitely/not/a/shell" });
  assert.equal(result.status, null);
  assert.ok(result.error);
});

// --- sandbox integration --------------------------------------------------

test("sandbox: Windows reports no backend with the WSL2 guidance", () => {
  const detected = detectSandbox({ platform: "win32" });
  assert.equal(detected.backend, null);
  assert.equal(detected.reason, WINDOWS_NO_FENCE);
  assert.match(detected.reason, /WSL2/);
  assert.match(detected.reason, /sandbox\.required:false/);
});

test("sandbox: the advisory argv uses cmd.exe on Windows", () => {
  const wrapped = wrapCommand("echo x", {
    backend: null,
    enforce: false,
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    profile: "(version 1)",
  });
  assert.equal(wrapped.enforced, false);
  assert.equal(wrapped.backend, null);
  assert.deepEqual(wrapped.argv, [
    "C:\\Windows\\System32\\cmd.exe",
    "/d",
    "/s",
    "/c",
    "echo x",
  ]);
});

test("sandbox: a POSIX backend fails closed on Windows", () => {
  for (const backend of ["seatbelt", "bwrap"]) {
    assert.throws(
      () => wrapCommand("echo x", { backend, platform: "win32", profile: "(version 1)" }),
      /unavailable on Windows/,
      backend,
    );
  }
});

// --- checks invariant -----------------------------------------------------

test("checks: runChecks still exports RATCHET=1 to the checked command", (t) => {
  const root = tempDir(t);
  const report = runChecks(
    root,
    [{ id: "env", cmd: 'node -e "process.stdout.write(process.env.RATCHET ?? \'missing\')"' }],
    { timeoutMs: 10000 },
  );
  assert.equal(report.ok, true, report.results[0]?.stderr);
  assert.equal(report.results[0].stdout, "1");
});

test("platform: OpenCode config dir follows the platform", () => {
  assert.equal(
    opencodeConfigDir("C:\\Users\\shiva", {
      platform: "win32",
      env: { APPDATA: "C:\\Users\\shiva\\AppData\\Roaming" },
    }),
    "C:\\Users\\shiva\\AppData\\Roaming\\opencode",
  );
  assert.equal(
    opencodeConfigDir("/home/shiva", { platform: "linux", env: {} }),
    "/home/shiva/.config/opencode",
  );
});
