// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, readJson, readText, repoRel, slug, stateDir, timestampId, writeJson, writeText } from "./fsx.mjs";

export const VERSION = 1;

export function configPath(root) {
  return path.join(stateDir(root), "config.json");
}

export function runsDir(root) {
  return path.join(stateDir(root), "runs");
}

export function runDir(root, id) {
  return path.join(runsDir(root), id);
}

export function loadConfig(root) {
  return readJson(configPath(root), null);
}

export function saveConfig(root, config) {
  writeJson(configPath(root), config);
}

export function defaultConfig(root) {
  return {
    version: VERSION,
    checks: detectChecks(root),
    post: [],
    gates: [],
    auto: {
      enabled: true,
      profile: "general",
      role: "coder",
      scope: ["**"],
      deny: [],
      routes: [],
      gates: [],
      maxFiles: 40,
      maxWrites: 120,
    },
    stop: {
      maxAttempts: 3,
    },
    defaults: {
      maxFiles: 12,
      maxWrites: 120,
      deny: [".git/**", "**/.git/**", ".env", "**/.env", ".env.*", "**/.env.*", "**/*.pem", "**/id_rsa", "**/secrets/**"],
    },
  };
}

function packageManager(root) {
  if (readText(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (readText(path.join(root, "yarn.lock"))) return "yarn";
  if (readText(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

/** Detect the repo's own checks. Prefer a single aggregate `check` script. */
export function detectChecks(root) {
  const pkg = readJson(path.join(root, "package.json"), null);
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.check === "string") {
    return [{ id: "check", cmd: `${packageManager(root)} run check` }];
  }
  const found = [];
  for (const name of ["lint", "typecheck", "type-check", "test", "build"]) {
    if (typeof scripts[name] !== "string") continue;
    found.push({ id: name, cmd: `${packageManager(root)} run ${name}` });
  }
  return found;
}

function gitHead(root) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function createContract(root, opts) {
  const id = `${timestampId()}-${slug(opts.goal)}`;
  return {
    version: VERSION,
    id,
    goal: String(opts.goal || "untitled task"),
    role: String(opts.role || "coder"),
    ...(opts.profile ? { profile: String(opts.profile) } : {}),
    ...(Array.isArray(opts.skills) ? { skills: opts.skills } : {}),
    createdAt: new Date().toISOString(),
    baseCommit: gitHead(root),
    readOnly: Boolean(opts.readOnly),
    scope: opts.scope ?? [],
    deny: opts.deny ?? [],
    gates: opts.gates ?? [],
    budgets: {
      maxFiles: Number(opts.maxFiles ?? 12),
      maxWrites: Number(opts.maxWrites ?? 120),
    },
    verify: (opts.verify ?? []).map((cmd, i) => ({ id: `verify-${i + 1}`, cmd })),
    checksLock: opts.checkSurface ?? null,
  };
}

export function saveContract(root, contract) {
  const dir = runDir(root, contract.id);
  ensureDir(dir);
  writeJson(path.join(dir, "contract.json"), contract);
  writeText(path.join(stateDir(root), "current"), contract.id + "\n");
  return dir;
}

export function currentId(root) {
  const raw = readText(path.join(stateDir(root), "current")).trim();
  return raw || null;
}

export function loadRun(root, id = currentId(root)) {
  if (!id) return null;
  const contract = readJson(path.join(runDir(root, id), "contract.json"), null);
  if (!contract || contract.version !== VERSION) return null;
  return contract;
}

/** A run stops being active once it has a result.json. */
export function runFinished(root, id) {
  if (!id) return false;
  return fs.existsSync(path.join(runDir(root, id), "result.json"));
}

/**
 * Release the current pointer after a run closes. Only clears it when it still
 * names this run, so a contract started in between is left alone.
 */
export function clearCurrent(root, id) {
  if (id && currentId(root) !== id) return false;
  try {
    fs.rmSync(path.join(stateDir(root), "current"), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Newest contract, finished or not. Reporting falls back to this after done. */
export function latestRun(root) {
  return allRuns(root)[0] ?? null;
}

/** Every readable contract in the runs directory, newest first. */
export function allRuns(root) {
  let entries;
  try {
    entries = fs.readdirSync(runsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contract = readJson(path.join(runsDir(root), entry.name, "contract.json"), null);
    if (contract && contract.version === VERSION) runs.push(contract);
  }
  return runs.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * Resolve the contract for an event's session. A contract bound to the session
 * wins. A manual contract with no session stays the fallback for CLI use.
 * Finished runs never resolve: `done` closes the gate, and a new task must
 * start a new contract.
 */
export function loadRunForSession(root, sessionId) {
  const runs = allRuns(root).filter((contract) => !runFinished(root, contract.id));
  const id = sessionId === undefined || sessionId === null ? "" : String(sessionId);
  if (id) {
    const match = runs.find(
      (contract) =>
        contract.session_id !== undefined &&
        contract.session_id !== null &&
        String(contract.session_id) === id,
    );
    if (match) return match;
  }
  // The fallback is the current pointer, never "any open run". A stranded run
  // from an old task would otherwise keep enforcing its old scope after `done`
  // cleared the pointer, while `ratchet status` reports "contract: none".
  const current = loadRun(root);
  if (!current || runFinished(root, current.id)) return null;
  // A session-bound contract belongs to its session; do not lend it to others.
  if (current.session_id !== undefined && current.session_id !== null) return null;
  return current;
}

export function eventsPath(root, id) {
  return path.join(runDir(root, id), "events.jsonl");
}

export function checksPath(root, id) {
  return path.join(runDir(root, id), "checks.json");
}

/**
 * Resolve symlinks in every existing path component. A lexical path inside the
 * scope can still land outside it through a link, so the guard checks the real
 * target. Dangling links are followed too.
 */
function realPath(abs, depth = 0) {
  if (depth > 40) return path.resolve(abs);
  const parts = path.resolve(abs).split(path.sep).filter(Boolean);
  let current = path.sep;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      out.push(...parts.slice(i));
      break;
    }
    if (!stat.isSymbolicLink()) {
      out.push(parts[i]);
      continue;
    }
    const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
    return realPath(path.join(target, ...parts.slice(i + 1)), depth + 1);
  }
  return path.join(path.sep, ...out);
}

/** Resolve a tool-named path against the event cwd, then express it repo-relative. */
export function normaliseTarget(root, cwd, p) {
  const base = cwd || root;
  const raw = String(p);
  const home = process.env.HOME || "";
  const expanded =
    raw === "~" ? home || raw : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
  const realRoot = realPath(path.resolve(root));
  return repoRel(realRoot, realPath(abs));
}

export function jsonResult(value) {
  return JSON.stringify(value, null, 2);
}
