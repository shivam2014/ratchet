// @ts-check
import { spawnSync } from "node:child_process";

/** Tracked modifications in the working tree and index. Untracked files do not count. */
export function trackedChanges(root) {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "-z", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const paths = [];
  const parts = String(result.stdout || "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const p = entry.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
    if (p) paths.push(p);
  }
  return [...new Set(paths)].sort();
}

/**
 * A contract can require a clean tree before it starts and again before it
 * closes. That makes a deploy contract certify a commit, not a working tree
 * that happens to contain someone else's uncommitted edits.
 */
export function cleanViolation(root, contract) {
  if (!contract?.requireClean) return null;
  const changed = trackedChanges(root);
  if (!changed) return null;
  if (!changed.length) return null;
  return [
    `REFUSED: contract ${contract.id} requires a clean tree; ${changed.length} tracked path(s) are modified:`,
    ...changed.slice(0, 20).map((p) => `  ${p}`),
    "Commit or revert them, then retry.",
  ].join("\n");
}
