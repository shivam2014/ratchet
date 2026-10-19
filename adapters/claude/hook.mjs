#!/usr/bin/env node
/**
 * Claude Code PreToolUse adapter.
 *
 * Safe to install globally: outside a repo with an active `.ratchet/current`
 * contract this exits 0 without output, so unrelated projects are untouched.
 * Inside a contract it forwards the raw hook JSON to `ratchet guard --format
 * claude` and passes the deny decision through.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function findContractRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet", "current"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let event = {};
  try {
    event = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }

  const cwd = event.cwd || process.cwd();
  if (!findContractRoot(cwd)) process.exit(0);

  const bin = path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");
  const result = spawnSync(process.execPath, [bin, "guard", "--format", "claude"], {
    input: raw,
    encoding: "utf8",
    cwd,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(0);
});
