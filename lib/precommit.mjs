// @ts-check
import { spawnSync } from "node:child_process";
import { liveRuns, loadConfig, loadRun, loadRunForSession } from "./contract.mjs";
import { runChecks } from "./checks.mjs";
import { matchesAny } from "./glob.mjs";

/**
 * Runtime state that must never be committed. It describes one machine's run,
 * not the repository, and a copy in git makes another checkout look active.
 */
export const GUARD_STATE = [
  ".ratchet",
  ".ratchet/",
  ".ratchet/current",
  ".ratchet/install.json",
  ".ratchet/last-check.json",
  ".ratchet/events.jsonl",
  ".ratchet/runs/**",
];

/** Repo-relative paths in the index. Null when git is unavailable. */
export function stagedPaths(root) {
  const result = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRD"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return [...new Set(String(result.stdout || "").split("\0").filter(Boolean))];
}

/**
 * The pre-commit decision. Scope first: a staged path the contract never
 * allowed is refused before spending time on the checks. The check commands
 * run only after the tree is known to be inside the contract.
 */
export function preCommitReport(root, options = {}) {
  const session = String(options.session ?? process.env.RATCHET_SESSION ?? "").trim();
  const live = liveRuns(root);
  const ambiguous = !session && live.length > 1;
  const contract = session ? loadRunForSession(root, session) : loadRun(root);
  const staged = stagedPaths(root);
  if (staged === null) {
    return { ok: false, error: "not a git repository", contract: null, staged: [] };
  }
  if (!staged.length) {
    return { ok: true, contract, staged, skipped: "nothing staged", checks: null };
  }
  if (ambiguous) {
    return {
      ok: false,
      contract: null,
      staged,
      error: `${live.length} live contracts share this checkout; set RATCHET_SESSION to the committing thread, or use one worktree per lead`,
      checks: null,
    };
  }

  const guard = staged.filter((p) => matchesAny(p, GUARD_STATE));
  const outside = contract
    ? staged.filter((p) => !matchesAny(p, contract.scope ?? []))
    : [];

  if (guard.length || outside.length) {
    return { ok: false, contract, staged, guard, outside, checks: null };
  }

  const checks = contract?.verify?.length
    ? contract.verify
    : loadConfig(root)?.checks ?? [];
  if (!checks.length) {
    return {
      ok: false,
      contract,
      staged,
      guard,
      outside,
      error: "No checks configured. Add them to .ratchet/config.json or pass --verify at task start.",
      checks: null,
    };
  }

  const report = runChecks(root, checks, {
    timeoutMs: Number(options.timeoutMs ?? 120000),
  });
  return { ok: report.ok, contract, staged, guard, outside, checks: report };
}
