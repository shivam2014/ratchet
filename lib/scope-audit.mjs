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
