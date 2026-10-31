// @ts-check
/**
 * Platform primitives: the shell, executable lookup, temp roots, and path
 * identity. Everything that differs between Windows, macOS, and Linux lives
 * here so the rest of Ratchet asks one module instead of assuming POSIX.
 *
 * The functions take an explicit `platform` option. Tests can then exercise
 * Windows behaviour on a POSIX host without changing `process.platform`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOWS = "win32";
const DEFAULT_PATHEXT = ".EXE;.CMD;.BAT;.COM";

export function isWindows(platform = process.platform) {
  return platform === WINDOWS;
}

/** Read an environment variable without relying on its casing (Windows). */
function envValue(env, name) {
  if (!env) return undefined;
  if (typeof env[name] === "string") return env[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted && typeof env[key] === "string") return env[key];
  }
  return undefined;
}

function platformPath(platform) {
  return isWindows(platform) ? path.win32 : path;
}

/**
 * The shell invocation for one command string.
 *
 * Windows uses cmd.exe (`%ComSpec%`) with the `/d /s /c` flags that make the
 * command run exactly as written. POSIX uses `/bin/sh -c`. Nothing here reads
 * or writes a file: callers decide the cwd and environment.
 */
export function shellCommand(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const text = String(command ?? "");
  if (isWindows(platform)) {
    const env = options.env ?? process.env;
    const file = options.comspec ?? envValue(env, "ComSpec") ?? "cmd.exe";
    return { file, args: ["/d", "/s", "/c", text] };
  }
  return { file: options.shell ?? "/bin/sh", args: ["-c", text] };
}

/** Run one command through the platform shell. Returns the raw spawnSync result. */
export function runShell(command, options = {}) {
  const { file, args } = shellCommand(command, options);
  return spawnSync(file, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: options.env,
    input: options.input,
  });
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Windows filesystems are case-insensitive; mirror that in the lookup. */
function fileInDir(dir, name) {
  const exact = path.join(dir, name);
  if (isFile(exact)) return exact;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const wanted = name.toLowerCase();
  const match = entries.find((entry) => entry.toLowerCase() === wanted);
  return match ? path.join(dir, match) : null;
}

function pathValue(env) {
  return envValue(env, "PATH") ?? "";
}

function windowsCandidateNames(command, pathext) {
  const ext = path.extname(command);
  if (ext) return [command];
  const raw = String(pathext || DEFAULT_PATHEXT);
  const extensions = raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
  return extensions.map((entry) => command + entry);
}

/**
 * Locate an executable the way the platform shell would.
 *
 * POSIX scans PATH for an executable regular file, then keeps the old
 * `command -v` fallback when a POSIX shell exists. Windows scans PATH with
 * PATHEXT and returns the first regular file; it never spawns `sh`, because a
 * Windows host is not guaranteed to have one.
 */
export function which(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const name = String(command ?? "").trim();
  if (!name) return null;
  const env = options.env ?? process.env;
  const impl = platformPath(platform);

  if (isWindows(platform)) {
    // An explicit path is not searched on PATH.
    if (name.includes("\\") || name.includes("/") || /^[A-Za-z]:/.test(name)) {
      const direct = impl.resolve(name);
      return isFile(direct) ? direct : null;
    }
    const pathext = options.pathext ?? envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT;
    const candidates = windowsCandidateNames(name, pathext);
    const rawPath = options.path ?? pathValue(env);
    for (const dir of String(rawPath).split(impl.delimiter)) {
      if (!dir) continue;
      for (const candidate of candidates) {
        const file = fileInDir(dir, candidate);
        if (file) return file;
      }
    }
    return null;
  }

  const direct = name.includes("/") ? path.resolve(name) : null;
  if (direct) return isExecutableFile(direct) ? direct : null;

  const rawPath = options.path ?? pathValue(env);
  for (const dir of String(rawPath).split(path.delimiter)) {
    if (!dir) continue;
    const file = path.resolve(dir, name);
    if (isExecutableFile(file)) return file;
  }

  // Fall back to `command -v` for anything a plain PATH scan misses. A host
  // without a POSIX shell simply has nothing to fall back to.
  const shell = options.shell ?? "/bin/sh";
  if (!fs.existsSync(shell)) return null;
  const result = spawnSync(shell, ["-c", 'command -v "$1"', "ratchet-which", name], {
    encoding: "utf8",
    env: options.env,
  });
  if (result.status !== 0) return null;
  const found = String(result.stdout || "").trim().split("\n").pop();
  return found || null;
}

/**
 * Temporary directories this machine actually uses: the POSIX roots on POSIX,
 * then the platform temp dir and the TMPDIR/TMP/TEMP overrides everywhere.
 * Every root is deduplicated and resolved to its real path when it exists.
 */
export function tempRoots(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const tmpdir = options.tmpdir ?? os.tmpdir();
  const impl = platformPath(platform);
  const excluded = new Set(
    (options.exclude ?? []).map((entry) => pathKey(impl.resolve(String(entry)), platform)),
  );
  const candidates = [];
  if (!isWindows(platform)) candidates.push("/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp");
  candidates.push(tmpdir, envValue(env, "TMPDIR"), envValue(env, "TMP"), envValue(env, "TEMP"));

  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const abs = impl.resolve(candidate);
    let real = abs;
    try {
      real = fs.realpathSync.native(abs);
    } catch {
      // A temp root that does not exist yet is still a valid future root.
    }
    const key = pathKey(real, platform);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    roots.push(real);
  }
  return roots;
}

/**
 * OpenCode's config directory. Windows installs use %APPDATA%\opencode;
 * macOS and Linux use ~/.config/opencode. The Git-Bash style path stays a
 * fallback so an existing install is not orphaned.
 */
export function opencodeConfigDir(home, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const impl = platformPath(platform);
  if (isWindows(platform) && env.APPDATA) return impl.join(env.APPDATA, "opencode");
  return impl.join(home, ".config", "opencode");
}

/** Comparison key for a path: Windows is case-insensitive, POSIX is not. */
export function pathKey(p, platform = process.platform) {
  const text = String(p);
  return isWindows(platform) ? text.toLowerCase() : text;
}

/** True when child is inside parent (or equal to it). */
export function pathIsInside(parent, child, platform = process.platform) {
  const impl = platformPath(platform);
  const p = impl.resolve(String(parent));
  const c = impl.resolve(String(child));
  const parentKey = pathKey(p, platform);
  const childKey = pathKey(c, platform);
  const prefix = parentKey.endsWith(impl.sep) ? parentKey : parentKey + impl.sep;
  return childKey === parentKey || childKey.startsWith(prefix);
}
