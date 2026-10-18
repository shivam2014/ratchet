#!/usr/bin/env node
/**
 * Codex PreToolUse adapter.
 *
 * Codex gives hooks `tool_name` and `tool_input`. `Bash` and `apply_patch`
 * carry `tool_input.command`. We normalise that to Ratchet's event shape and
 * emit Codex's deny JSON when the guard blocks.
 *
 * This hook is safe to install globally: outside a repo with an active
 * `.ratchet/current` contract it exits 0 and does nothing.
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

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[ratchet] ${reason}`,
      },
    }),
  );
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cwd = event.cwd || process.cwd();
  if (!findContractRoot(cwd)) process.exit(0);

  const name = String(event.tool_name || "");
  let tool = "other";
  let input = {};

  if (/^bash$/i.test(name)) {
    tool = "bash";
    input = { command: event.tool_input?.command ?? "" };
  } else if (/^(apply_patch|edit|write)$/i.test(name)) {
    tool = "write";
    input = { patch: event.tool_input?.command ?? event.tool_input?.patch ?? "" };
  } else {
    // MCP and other local tools are not path-classified yet. Allow and let
    // CI be the authority rather than blocking every unknown tool.
    process.exit(0);
  }

  const payload = {
    harness: "codex",
    session_id: event.session_id ?? null,
    agent: event.agent_type ?? null,
    tool,
    input,
    cwd,
  };
  const bin =
    process.env.RATCHET_BIN ||
    path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");
  const result = spawnSync(process.execPath, [bin, "guard", "--format", "json"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd,
  });

  if (result.error) {
    deny(`guard failed: ${result.error.message}`);
    return;
  }

  let decision;
  try {
    decision = JSON.parse(result.stdout);
  } catch {
    deny("guard returned invalid JSON");
    return;
  }

  if (!decision.allow) deny(decision.reason || "blocked by the task contract");
});
