// @ts-check
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
      maxWrites: 60,
      deny: [".git/**", ".env", ".env.*", "**/*.pem", "**/id_rsa", "**/secrets/**"],
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
      maxWrites: Number(opts.maxWrites ?? 60),
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

export function eventsPath(root, id) {
  return path.join(runDir(root, id), "events.jsonl");
}

export function checksPath(root, id) {
  return path.join(runDir(root, id), "checks.json");
}

/** Resolve a tool-named path against the event cwd, then express it repo-relative. */
export function normaliseTarget(root, cwd, p) {
  const base = cwd || root;
  const abs = path.isAbsolute(String(p)) ? String(p) : path.resolve(base, String(p));
  return repoRel(root, abs);
}

export function jsonResult(value) {
  return JSON.stringify(value, null, 2);
}
