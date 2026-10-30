// @ts-check
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runDir } from "./contract.mjs";
import { ensureDir, readJson, readText, stateDir, writeJson, writeText } from "./fsx.mjs";

/**
 * CI status is evidence, not a gate. It is fetched on demand from an
 * authenticated `gh`, never from a webhook or a background poll, and cached
 * per commit so evidence and digest can ask repeatedly without hammering the
 * API. A missing `gh`, a signed-out account, or a network failure is reported
 * as `unknown`; it never fails the run.
 */

export const DEFAULT_TTL_MS = 120_000;
const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 50;

const FAIL_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

const RUNNING_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
]);

export function ciCachePath(root) {
  return path.join(stateDir(root), "ci-cache.json");
}

export function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() || null : null;
}

/**
 * The commit a run certifies. A finished run records the HEAD it closed on;
 * before that, the commit it started from is the best available answer. With
 * no run at all, CI means the current checkout's HEAD.
 */
export function commitForRun(root, contract) {
  if (!contract) return gitHead(root);
  const result = readJson(path.join(runDir(root, contract.id), "result.json"), null);
  return result?.git?.head ?? contract.baseCommit ?? gitHead(root);
}

/** Map one `gh run list` row to the four states Ratchet reports. */
export function classifyRun(run) {
  const status = String(run?.status ?? "").toLowerCase();
  const conclusion = String(run?.conclusion ?? "").toLowerCase();
  if (RUNNING_STATUSES.has(status)) return "running";
  if (status === "completed") {
    if (conclusion === "success") return "pass";
    if (FAIL_CONCLUSIONS.has(conclusion)) return "fail";
  }
  // An unrecognised status is not a pass and not a failure: say so.
  return "unknown";
}

function unknown(reason, commit) {
  return {
    state: /** @type {"unknown"} */ ("unknown"),
    url: null,
    workflow: null,
    checkedAt: new Date().toISOString(),
    reason,
    commit: commit ?? null,
  };
}

function cacheShape(value) {
  if (!value || typeof value !== "object" || !value.commits || typeof value.commits !== "object") {
    return { version: CACHE_VERSION, commits: {} };
  }
  return {
    version: CACHE_VERSION,
    commits: value.commits,
  };
}

function pruneCache(cache) {
  const entries = Object.entries(cache.commits).sort(
    (a, b) => Number(b[1]?.fetchedAt ?? 0) - Number(a[1]?.fetchedAt ?? 0),
  );
  return {
    version: CACHE_VERSION,
    commits: Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES)),
  };
}

/** Keep `ci-cache.json` out of git even in a repo initialised before this feature. */
function ensureCacheIgnored(root) {
  const file = path.join(stateDir(root), ".gitignore");
  const current = readText(file, "");
  if (current.split(/\r?\n/).some((line) => line.trim() === "ci-cache.json")) return;
  const next = current && !current.endsWith("\n") ? `${current}\n` : current;
  writeText(file, `${next}ci-cache.json\n`);
}

function persist(root, commit, status) {
  try {
    const file = ciCachePath(root);
    const cache = cacheShape(readJson(file, null));
    cache.commits[commit] = {
      status,
      fetchedAt: Date.now(),
    };
    ensureDir(path.dirname(file));
    // Ignore the cache before it exists, so a crash cannot leave an untracked
    // runtime file in the user's next `git status`.
    ensureCacheIgnored(root);
    writeJson(file, pruneCache(cache));
  } catch {
    // The cache is an optimisation. A read-only checkout must still report CI.
  }
}

function firstLine(text) {
  return String(text || "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function queryCi(root, commit, options) {
  const timeoutMs = Number(options.timeoutMs ?? 15_000);
  const result = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--commit",
      commit,
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,url,workflowName",
    ],
    { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
  );

  if (result.error) {
    const code = String(result.error.code ?? "");
    if (code === "ENOENT") {
      return unknown("gh is not installed; install GitHub CLI (https://cli.github.com) or omit --ci", commit);
    }
    if (code === "ETIMEDOUT") {
      return unknown(`gh timed out after ${timeoutMs}ms; retry with: ratchet ci`, commit);
    }
    return unknown(`gh could not run: ${result.error.message}`, commit);
  }

  if (result.status !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`;
    if (/auth|login|token|credential/i.test(detail)) {
      return unknown("gh is not authenticated; run: gh auth login", commit);
    }
    if (/no runs? found|no workflow runs?/i.test(detail)) {
      return unknown(`no workflow run found for ${commit}`, commit);
    }
    return unknown(`gh run list failed: ${detail}`, commit);
  }

  let runs;
  try {
    runs = JSON.parse(String(result.stdout || "[]"));
  } catch {
    return unknown("gh returned unreadable JSON; retry with: ratchet ci", commit);
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return unknown(`no workflow run found for ${commit}`, commit);
  }

  const run = runs[0] ?? {};
  const state = classifyRun(run);
  const workflow = typeof run.workflowName === "string" && run.workflowName ? run.workflowName : null;
  const url = typeof run.url === "string" && run.url ? run.url : null;
  const conclusion = String(run.conclusion ?? "").toLowerCase();
  const status = String(run.status ?? "").toLowerCase();
  const reason =
    state === "pass"
      ? `workflow ${workflow ?? "(unnamed)"} succeeded`
      : state === "fail"
        ? `workflow ${workflow ?? "(unnamed)"} concluded ${conclusion || "failed"}`
        : state === "running"
          ? `workflow ${workflow ?? "(unnamed)"} is ${status || "running"}`
          : `workflow ${workflow ?? "(unnamed)"} finished with ${conclusion || status || "an unknown state"}`;

  return {
    state,
    url,
    workflow,
    checkedAt: new Date().toISOString(),
    reason,
    commit,
    runId: run.databaseId ?? null,
  };
}

/**
 * CI for one commit. Cached for `ttlMs` (default 120s, override with
 * `RATCHET_CI_TTL_MS` or options.ttlMs). Never throws.
 */
export function ciStatus(root, commit, options = {}) {
  const sha = String(commit ?? "").trim();
  if (!sha) return unknown("no commit to check; run inside a git checkout or pass --run <id>", null);

  const ttlMs = Number(options.ttlMs ?? process.env.RATCHET_CI_TTL_MS ?? DEFAULT_TTL_MS);
  const cacheFile = ciCachePath(root);
  const cache = cacheShape(readJson(cacheFile, null));
  const cached = cache.commits[sha];
  if (
    cached &&
    cached.status &&
    typeof cached.status === "object" &&
    ttlMs > 0 &&
    Date.now() - Number(cached.fetchedAt ?? 0) < ttlMs
  ) {
    return { ...cached.status, cached: true };
  }

  const status = queryCi(root, sha, options);
  persist(root, sha, status);
  return status;
}
