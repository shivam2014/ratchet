/**
 * Cross-platform fixtures shared by the test files. This is deliberately not
 * named `*.test.mjs`: `node --test test/*.test.mjs` would load it as a suite.
 *
 * The suite runs on macOS, Linux, and Windows. The differences that matter:
 *   - Windows has no shebang, so a `ratchet` stub is a `.cmd` batch file;
 *   - Windows has no `/var/tmp`, so anything outside the repo and the OS temp
 *     root lives under the user's home directory;
 *   - Windows only allows directory links (junctions) without elevation, so
 *     symlink fixtures ask for the type explicitly and skip when the host
 *     filesystem refuses.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const BIN = path.join(ROOT, "bin", "ratchet.mjs");
export const IS_WINDOWS = process.platform === "win32";
export const IS_POSIX = !IS_WINDOWS;

const TEMP_ROOT = path.resolve(os.tmpdir());
const HOME = path.resolve(os.homedir());
const exitCleanups = [];
let exitHookInstalled = false;

/** True when `child` is `root` or lives under it. */
export function isInside(root, child) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A node:test `skip` value. Returns false on POSIX and a reason on Windows:
 *
 *   test("...", { skip: posixOnly("needs a POSIX shell") }, (t) => { ... });
 */
export function posixOnly(reason = "POSIX only") {
  return IS_WINDOWS ? `POSIX only: ${reason}` : false;
}

/** The mirror of `posixOnly`: false on Windows, a reason elsewhere. */
export function windowsOnly(reason = "Windows only") {
  return IS_WINDOWS ? false : `Windows only: ${reason}`;
}

/**
 * Create a real directory link. Windows needs an explicit kind: a junction
 * works without Developer Mode and still shows up as a symlink to lstat, so
 * the guard exercises the same resolution path as on POSIX.
 */
export function linkDir(target, link) {
  fs.symlinkSync(target, link, IS_WINDOWS ? "junction" : "dir");
}

let linkProbe;
/** Whether this host and filesystem actually allow `linkDir`. Probed once. */
export function canLinkDir() {
  if (linkProbe !== undefined) return linkProbe;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-link-probe-"));
  try {
    const target = path.join(dir, "target");
    fs.mkdirSync(target);
    linkDir(target, path.join(dir, "link"));
    linkProbe = true;
  } catch {
    linkProbe = false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return linkProbe;
}

/** A node:test `skip` value for suites that need a directory link. */
export function symlinkSkip(reason = "directory links are not permitted on this host") {
  return canLinkDir() ? false : reason;
}

/**
 * A directory outside both the repo and the OS temp root. Tests about escapes
 * and sibling directories need a path that is neither in the checkout nor
 * covered by the temp allowance.
 *
 * `t` is a node:test context (pass null when there is none). With a context
 * the directory is removed in `t.after`; otherwise at process exit.
 */
export function outsideDir(t, prefix = "outside-") {
  const base = outsideBase();
  const safe = String(prefix).replace(/[^A-Za-z0-9._-]+/g, "-");
  const dir = fs.mkdtempSync(path.join(base, `.ratchet-test-${safe}`));
  registerCleanup(t, dir);
  return dir;
}

function outsideBase() {
  const candidates = [
    HOME,
    // A HOME inside the temp root (some CI sandboxes) is not outside it.
    path.join(path.dirname(TEMP_ROOT), "ratchet-test-home"),
  ];
  for (const candidate of candidates) {
    const base = path.resolve(candidate);
    if (isInside(TEMP_ROOT, base)) continue;
    if (isInside(ROOT, base)) continue;
    try {
      fs.mkdirSync(base, { recursive: true });
      return base;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("cannot find a directory outside the repo and the temp root");
}

function registerCleanup(t, dir) {
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  if (t && typeof t.after === "function") {
    t.after(remove);
    return;
  }
  exitCleanups.push(remove);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const cleanup of exitCleanups) cleanup();
    });
  }
}

/**
 * Write an executable `ratchet` stub that runs this checkout's CLI. POSIX gets
 * a `#!/bin/sh` script; Windows gets a `ratchet.cmd` batch file. Returns the
 * path to put in `RATCHET_BIN`.
 *
 * `options.name` renames the stub. `options.exit` writes a stub that only
 * fails, for the "a crashing ratchet binary fails closed" tests.
 */
export function shimRatchet(binDir, options = {}) {
  const { name = "ratchet", exit = null } = options;
  fs.mkdirSync(binDir, { recursive: true });

  if (IS_WINDOWS) {
    const file = path.join(binDir, `${name}.cmd`);
    const lines = ["@echo off"];
    if (exit === null) {
      lines.push(`set "NODE=${process.execPath}"`);
      lines.push(`set "BIN=${BIN}"`);
      lines.push('"%NODE%" "%BIN%" %*');
    } else {
      lines.push(`exit /b ${exit}`);
    }
    fs.writeFileSync(file, `${lines.join("\r\n")}\r\n`);
    return file;
  }

  const file = path.join(binDir, name);
  const body = exit === null ? `exec "${process.execPath}" "${BIN}" "$@"` : `exit ${exit}`;
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * A git repo with a base commit, for tests that compare against `HEAD` or
 * audit the working tree. `pkg` is an optional full package.json body; omit it
 * for a repo with no package.json.
 */
export function tempRepo(t, prefix = "ratchet-repo-", pkg = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerCleanup(t, dir);
  spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (pkg) fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base"],
    { cwd: dir, encoding: "utf8" },
  );
  return dir;
}

/** Spawn this Node binary and decode stdout/stderr as UTF-8. */
export function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", ...options });
}
