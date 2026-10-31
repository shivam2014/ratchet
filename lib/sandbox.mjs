// @ts-check
/**
 * Kernel write fence for bash tool calls.
 *
 * The guard is policy: it reads a command, infers paths, and returns a
 * decision. This module is the physical layer underneath it. Given a repo and
 * a live contract, it builds a profile that allows reads everywhere and writes
 * only under the contract's static scope roots, the repo's git directory,
 * temp directories, and common caches. A command that tries to write anywhere
 * else fails with EPERM inside the kernel, even when the classifier missed it.
 *
 * Backends:
 *   - macOS: seatbelt via /usr/bin/sandbox-exec.
 *   - Linux: bubblewrap (bwrap) when it is on PATH.
 *   - Anything else: unsupported, and `detectSandbox` says why.
 *
 * Nothing here guesses. A missing backend is reported, and `wrapCommand` fails
 * closed unless the caller explicitly asks for an advisory (unfenced) result.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWindows, shellCommand, tempRoots as platformTempRoots } from "./platform.mjs";

export const SEATBELT = "/usr/bin/sandbox-exec";
export const DEV_WRITES = ["/dev/null"];
export const WINDOWS_NO_FENCE =
  "Windows has no native kernel write fence; install WSL2 with bubblewrap (bwrap) to use the WSL backend, or use sandbox.required:false and rely on the git audit and CI";

// Guard state is not task state. Even when the contract scope is `**` (the
// repo root), arbitrary bash must not rewrite the kill switch, the active
// pointer, the contract, or its own evidence. The ratchet CLI is exempt from
// the fence as the control plane, so `check`, `done`, and `amend` still work.
export const GUARD_STATE_FILES = [
  ".ratchet/current",
  ".ratchet/config.json",
  ".ratchet/disabled.json",
  ".ratchet/install.json",
  ".ratchet/rules.tsv",
  ".ratchet/events.jsonl",
  ".ratchet/last-check.json",
];
export const GUARD_STATE_DIRS = [".ratchet/runs"];

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command, envPath = process.env.PATH ?? "") {
  for (const dir of String(envPath).split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, command);
    try {
      if (fs.statSync(file).isFile() && isExecutable(file)) return file;
    } catch {
      // Not here. Keep looking.
    }
  }
  return null;
}

const WSL_CACHE_MS = 60_000;
let wslCache = null;

/** Ask WSL2 for bwrap. Injected in tests; cached so a guard call is not a probe. */
function wslBwrap(wslBin, options = {}) {
  if (options.wsl && typeof options.wsl.bwrap === "string") return options.wsl.bwrap;
  if (typeof options.wslProbe === "function") return options.wslProbe(wslBin);
  if (wslCache && wslCache.bin === wslBin && Date.now() - wslCache.at < WSL_CACHE_MS) {
    return wslCache.bwrap;
  }
  let bwrap = null;
  const result = spawnSync(wslBin, ["--exec", "sh", "-c", "command -v bwrap"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status === 0) bwrap = String(result.stdout || "").trim() || null;
  wslCache = { bin: wslBin, bwrap, at: Date.now() };
  return bwrap;
}

/**
 * Translate a Windows path to the WSL2 mount path. Only drive-letter paths are
 * rewritten; a POSIX path passes through, and a caller can inject a resolver.
 */
export function toWslPath(value, options = {}) {
  if (typeof options.wslPath === "function") return options.wslPath(value);
  const text = String(value).replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(text);
  if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  // Git Bash / MSYS uses /c/repo; WSL wants /mnt/c/repo. Only rewrite on
  // Windows, so a real /c directory on Linux is left alone.
  const platform = options.platform ?? process.platform;
  if (isWindows(platform)) {
    const msys = /^\/([A-Za-z])\/(.*)$/.exec(text);
    if (msys) return `/mnt/${msys[1].toLowerCase()}/${msys[2]}`;
  }
  return text;
}

/**
 * Report the available write fence backend. Never returns a backend that was
 * not actually found: a null backend always comes with a reason.
 */
export function detectSandbox(options = {}) {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((file) => isExecutable(file));

  if (platform === "darwin") {
    if (exists(SEATBELT)) {
      return { backend: "seatbelt", bin: SEATBELT, reason: `seatbelt available (${SEATBELT})` };
    }
    return { backend: null, bin: null, reason: "macOS seatbelt unavailable: /usr/bin/sandbox-exec not found or not executable" };
  }

  if (platform === "linux") {
    const bin = options.which ? options.which("bwrap") : findOnPath("bwrap");
    if (bin) return { backend: "bwrap", bin, reason: `bubblewrap available (${bin})` };
    return { backend: null, bin: null, reason: "Linux bubblewrap unavailable: bwrap not found on PATH" };
  }

  if (isWindows(platform)) {
    const wslBin =
      options.wsl?.bin ??
      (options.which ? options.which("wsl.exe") : findOnPath("wsl.exe"));
    if (!wslBin) return { backend: null, bin: null, reason: WINDOWS_NO_FENCE };
    const bwrap = wslBwrap(wslBin, options);
    if (bwrap) {
      return {
        backend: "wsl-bwrap",
        bin: wslBin,
        bwrap,
        reason: `WSL2 bubblewrap available (${wslBin} -> ${bwrap})`,
      };
    }
    return {
      backend: null,
      bin: null,
      reason: `${WINDOWS_NO_FENCE} (wsl.exe found, but bwrap is not installed in the default distro)`,
    };
  }

  return { backend: null, bin: null, reason: `unsupported platform ${platform}: no write fence backend` };
}

/** POSIX shell quoting for one argument. */
export function quote(value) {
  const text = String(value);
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** One SBPL string literal. Paths are the only untrusted part of a profile. */
function sbpl(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

/**
 * The deepest directory that contains every path a glob can match. `src/**`
 * and `src/*.ts` both return `<root>/src`; `**` and a bare filename return the
 * repo root. A pattern that escapes the repo is clamped back to the root, so a
 * malformed contract can never widen the fence.
 */
export function staticPrefix(root, pattern) {
  const repo = path.resolve(root);
  let raw = String(pattern ?? "").trim();
  if (!raw) return null;
  raw = raw.replace(/^\.\//, "");
  const meta = raw.search(/[*?[\]{}()!+@]/);
  let prefix = meta === -1 ? raw : raw.slice(0, meta);
  if (!prefix.endsWith("/")) prefix = path.posix.dirname(prefix);
  prefix = prefix.replace(/\/+$/, "");
  if (prefix === "." || prefix === "/") prefix = "";

  const abs = path.resolve(repo, prefix);
  const rel = path.relative(repo, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return repo;
  return abs;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Both the literal path and its real target, because /tmp is a symlink. */
function realBoth(value) {
  const abs = path.resolve(value);
  const out = [abs];
  try {
    const real = fs.realpathSync.native(abs);
    if (real !== abs) out.push(real);
  } catch {
    // A directory that does not exist yet is still a valid future write root;
    // the literal path is enough for Seatbelt and bwrap.
  }
  return out;
}

function cacheRoots(home) {
  const roots = [path.join(home, ".npm"), path.join(home, ".cache"), path.join(home, "Library", "Caches")];
  if (process.env.XDG_CACHE_HOME) roots.push(process.env.XDG_CACHE_HOME);
  return roots;
}

/**
 * The repo's git write roots. In a normal checkout `.git` is a directory; in a
 * git worktree it is a file naming a gitdir outside the repo, and the gitdir
 * may name a shared commondir. Git must write index, locks, and objects to
 * both, or every sandboxed `git` call fails.
 */
function gitRoots(repo) {
  const dotGit = path.join(repo, ".git");
  const roots = [];
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) {
      roots.push(dotGit);
    } else if (stat.isFile()) {
      const match = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const gitdir = path.resolve(repo, match[1].trim());
        roots.push(gitdir);
        try {
          const common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
          if (common) roots.push(path.resolve(gitdir, common));
        } catch {
          // No commondir: a standalone gitdir. The gitdir itself is enough.
        }
      }
    }
  } catch {
    // Not a git repo. The literal path is still harmless in a profile.
  }
  if (!roots.length) roots.push(dotGit);
  return roots;
}

/**
 * Absolute directories a sandboxed command may write to. Deterministic for a
 * given root, contract, home, and temp environment.
 */
export function writeRoots(root, contract, options = {}) {
  const repo = path.resolve(root);
  // A read-only role is a capability boundary, not a suggestion. Keep its
  // scope closed in the kernel too; git, temp, and caches stay writable so
  // read commands (and the tools they spawn) still work.
  const scope = contract?.readOnly ? [] : Array.isArray(contract?.scope) ? contract.scope : [];
  const home = options.home ?? process.env.HOME ?? os.homedir();

  const scopeRoots = scope.map((pattern) => staticPrefix(repo, pattern)).filter(Boolean);
  const extra = (options.extraWrites ?? [])
    .filter((value) => typeof value === "string" && value)
    .map((value) => (path.isAbsolute(value) ? value : path.resolve(repo, value)));
  const temp = options.tempRoots ?? platformTempRoots();
  const caches = options.cacheRoots ?? (home ? cacheRoots(home) : []);

  const dirs = unique(
    [...scopeRoots, ...gitRoots(repo), ...temp, ...caches, ...extra].flatMap(realBoth),
  ).sort();

  return { repo, dirs, dev: [...DEV_WRITES] };
}

/**
 * A Seatbelt SBPL profile: reads are allowed by default, every file write is
 * denied, then the allowed roots are re-opened. This is an allow-list fence,
 * not a list of known-bad paths.
 */
export function buildProfile(root, contract, options = {}) {
  const { dirs, dev } = writeRoots(root, contract, options);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
  ];
  for (const dir of dirs) lines.push(`(allow file-write* (subpath ${sbpl(dir)}))`);
  for (const file of dev) lines.push(`(allow file-write* (literal ${sbpl(file)}))`);
  // Last match wins in SBPL, so these denials override a `**` scope allow.
  for (const repo of realBoth(path.resolve(root))) {
    for (const file of GUARD_STATE_FILES) {
      lines.push(`(deny file-write* (literal ${sbpl(path.join(repo, file))}))`);
    }
    for (const dir of GUARD_STATE_DIRS) {
      lines.push(`(deny file-write* (subpath ${sbpl(path.join(repo, dir))}))`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Command text that is only the ratchet control plane (optionally after a
 * single `cd <dir> &&`): `check`, `done`, `amend`, `abandon`, or `sandbox`.
 * Those must write `.ratchet` evidence the fence deliberately excludes, so they
 * run unfenced. Everything else, including `ratchet run` and `ratchet hook`,
 * is fenced: both can spawn arbitrary work. Anything compound is also fenced,
 * because a denied write could hide in the second half.
 */
export function isControlPlaneCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) return false;
  const separators = [];
  let quoteChar = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoteChar) {
      if (ch === "\\" && quoteChar === '"') {
        i++;
        continue;
      }
      if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoteChar = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      separators.push({ ch, at: i });
      if ((ch === "&" || ch === "|") && text[i + 1] === ch) i++;
    }
  }

  const control = /^ratchet\s+(?:check|done|amend|abandon|sandbox)(?:\s|$)/;
  if (!separators.length) return control.test(text);
  if (separators.length !== 1 || separators[0].ch !== "&") return false;

  const at = separators[0].at;
  if (text[at + 1] !== "&") return false;
  const head = text.slice(0, at).trim();
  const tail = text.slice(at + 2).trim();
  return /^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)$/.test(head) && control.test(tail);
}

/**
 * Build the backend invocation for a command.
 *
 * `enforce: false` returns the plain command when no backend exists, which is
 * the advisory metadata path. The default is fail-closed: no backend means no
 * execution and a thrown error.
 */
export function wrapCommand(command, options = {}) {
  const text = String(command ?? "");
  if (!text.trim()) throw new Error("cannot sandbox an empty command");
  const platform = options.platform ?? process.platform;

  const detected =
    options.backend !== undefined
      ? {
          backend: options.backend,
          bin: options.bin ?? (options.backend === "seatbelt" ? SEATBELT : options.backend === "bwrap" ? "bwrap" : null),
          bwrap: options.bwrap,
          reason: options.reason ?? "backend supplied by caller",
        }
      : detectSandbox({ platform });

  // Seatbelt and native bubblewrap are POSIX only. On Windows the only
  // supported route is wsl-bwrap; everything else is a refusal.
  if (isWindows(platform) && detected.backend && detected.backend !== "wsl-bwrap") {
    const error = new Error(`sandbox backend ${detected.backend} is unavailable on Windows: ${WINDOWS_NO_FENCE}`);
    // @ts-expect-error - a machine-readable code for callers that inspect it
    error.code = "SANDBOX_UNAVAILABLE";
    throw error;
  }

  const enforce = options.enforce !== false;
  if (!detected.backend) {
    if (enforce) {
      const error = new Error(`sandbox unavailable: ${detected.reason}`);
      // @ts-expect-error - a machine-readable code for callers that inspect it
      error.code = "SANDBOX_UNAVAILABLE";
      throw error;
    }
    const shell = shellCommand(text, { platform, env: options.env });
    return {
      backend: null,
      enforced: false,
      profile: options.profile ?? null,
      argv: [shell.file, ...shell.args],
      command: text,
      cwd: options.cwd ? path.resolve(options.cwd) : null,
      reason: detected.reason,
    };
  }

  const root = path.resolve(options.root ?? process.cwd());
  const profile = options.profile ?? buildProfile(root, options.contract, options);
  const cwd = options.cwd ? path.resolve(options.cwd) : null;

  if (detected.backend === "seatbelt") {
    const bin = detected.bin ?? SEATBELT;
    const argv = [bin, "-p", profile, "/bin/sh", "-c", text];
    return {
      backend: "seatbelt",
      enforced: true,
      profile,
      argv,
      command: argv.map(quote).join(" "),
      cwd,
      reason: detected.reason,
    };
  }

  if (detected.backend === "bwrap" || detected.backend === "wsl-bwrap") {
    const wsl = detected.backend === "wsl-bwrap";
    const bin = wsl ? detected.bin ?? "wsl.exe" : detected.bin ?? "bwrap";
    const bwrap = wsl ? detected.bwrap || "/usr/bin/bwrap" : bin;
    const { dirs } = writeRoots(root, options.contract, options);
    const existing = dirs.filter((dir) => fs.existsSync(dir));
    const wslDirs = wsl ? existing.map((dir) => toWslPath(dir, { ...options, platform })) : existing;
    const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    for (const dir of wslDirs) {
      args.push("--bind", dir, dir);
    }
    args.push("--chdir", wsl ? toWslPath(cwd ?? root, { ...options, platform }) : cwd ?? root, "/bin/sh", "-c", text);
    const argv = wsl ? [bin, "--exec", bwrap, ...args] : [bin, ...args];
    return {
      backend: detected.backend,
      enforced: true,
      profile: wsl ? null : profile,
      argv,
      command: argv.map(quote).join(" "),
      cwd,
      reason: detected.reason,
    };
  }

  throw new Error(`unsupported sandbox backend: ${detected.backend}`);
}

/**
 * Run one command under the profile. Returns the exit status and captured
 * output, plus the backend that actually ran. When no backend exists the
 * command does not run: status 126 and the reason on stderr.
 */
export function runSandboxed(command, options = {}) {
  let wrapped;
  try {
    wrapped = wrapCommand(command, options);
  } catch (error) {
    return {
      status: 126,
      stdout: "",
      stderr: `${error.message}\n`,
      backend: null,
      command: String(command ?? ""),
      error,
    };
  }

  const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
  });

  const stderr = result.error
    ? `${result.stderr ?? ""}${result.stderr ? "\n" : ""}${result.error.message}`
    : result.stderr ?? "";

  return {
    status: typeof result.status === "number" ? result.status : 126,
    stdout: result.stdout ?? "",
    stderr,
    backend: wrapped.backend,
    command: wrapped.command,
    error: result.error ?? null,
  };
}
