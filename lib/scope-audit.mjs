// @ts-check
import { spawnSync } from "node:child_process";
import { matchesAny } from "./glob.mjs";

/** Repo-relative paths changed in the working tree. Null when git is absent. */
export function changedPaths(root) {
  const result = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const parts = String(result.stdout || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const p = entry.slice(3);
    // Rename/copy entries carry the original path in the next field.
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/**
 * Paths the task changed: commits since the contract's base plus the current
 * working tree. `done` uses this so a committed out-of-scope file is caught,
 * not just an uncommitted one.
 */
export function taskChanges(root, contract) {
  const paths = new Set();
  if (contract?.baseCommit) {
    const result = spawnSync("git", ["diff", "--name-only", "-z", `${contract.baseCommit}..HEAD`], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status === 0) {
      for (const p of String(result.stdout || "").split("\0")) if (p) paths.add(p);
    }
  }
  for (const p of changedPaths(root) ?? []) paths.add(p);
  return [...paths].filter((p) => !p.startsWith(".ratchet/")).sort();
}

/** Task changes outside the contract scope, committed or not. */
export function taskScopeViolations(root, contract) {
  return taskChanges(root, contract).filter((p) => !matchesAny(p, contract.scope ?? []));
}

/**
 * Files the contract did not allow. Git sees every write, however it was
 * produced: shell, interpreter, compiled binary, or a tool ratchet does not
 * classify. This is the audit that makes the shell classifier advisory.
 */
export function scopeViolations(root, contract) {
  const changed = changedPaths(root);
  if (!changed) return [];
  const scope = contract.scope ?? [];
  return changed.filter((p) => !p.startsWith(".ratchet/") && !matchesAny(p, scope));
}
