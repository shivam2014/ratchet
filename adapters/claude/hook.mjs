#!/usr/bin/env node
/**
 * Claude Code lifecycle adapter for UserPromptSubmit, PreToolUse, PostToolUse,
 * and Stop.
 *
 * Safe to install globally: outside a repo with a `.ratchet` directory every
 * event exits 0 without output, so unrelated projects stay untouched. Prompt
 * events need `.ratchet/config.json`; tool and stop events need an active
 * `.ratchet/current` contract. Inside a Ratchet repo the raw hook JSON becomes
 * a normalized `ratchet hook` event and the decision is translated back to the
 * shape Claude Code expects for that event.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");

function findRatchetRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function sessionId(raw) {
  const value = raw.session_id ?? raw.sessionId;
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "unknown";
}

/** Claude reports failures in a few shapes; the trail only needs ok/exit. */
function toolResult(raw) {
  const response = raw.tool_response;
  if (typeof response === "string") return { ok: true };
  const object = asObject(response);
  if (typeof object.is_error === "boolean") return { ok: !object.is_error };
  if (typeof object.exit === "number" && Number.isFinite(object.exit)) {
    return { ok: object.exit === 0, exit: object.exit };
  }
  return { ok: true };
}

const EVENTS = {
  UserPromptSubmit(raw, base) {
    return {
      ...base,
      type: "prompt.submit",
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    };
  },
  PreToolUse(raw, base) {
    if (typeof raw.tool_name !== "string" || !raw.tool_name) return null;
    return {
      ...base,
      type: "tool.before",
      tool: raw.tool_name,
      input: asObject(raw.tool_input),
    };
  },
  PostToolUse(raw, base) {
    if (typeof raw.tool_name !== "string" || !raw.tool_name) return null;
    return {
      ...base,
      type: "tool.after",
      tool: raw.tool_name,
      input: asObject(raw.tool_input),
      result: toolResult(raw),
    };
  },
  Stop(raw, base) {
    const event = { ...base, type: "turn.stop" };
    if (typeof raw.last_assistant_message === "string") event.last_message = raw.last_assistant_message;
    return event;
  },
};

const RESPONSES = {
  UserPromptSubmit(decision) {
    if (typeof decision?.context !== "string" || !decision.context.trim()) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: decision.context,
      },
    };
  },
  PreToolUse(decision) {
    if (decision?.allow !== false) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[ratchet] ${decision.reason ?? "blocked by ratchet"}`,
      },
    };
  },
  PostToolUse() {
    return null;
  },
  Stop(decision) {
    if (decision?.allow !== false) return null;
    return { decision: "block", reason: decision.reason ?? "ratchet: verification failed" };
  },
};

function handle(raw) {
  let hook;
  try {
    hook = JSON.parse(raw || "{}");
  } catch {
    return null;
  }

  if (typeof hook !== "object" || hook === null || Array.isArray(hook)) return null;

  const name = hook.hook_event_name;
  if (typeof name !== "string" || !Object.hasOwn(EVENTS, name)) return null;
  const build = EVENTS[name];

  const cwd = typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd();
  const root = findRatchetRoot(cwd);
  if (!root) return null;
  const state = path.join(root, ".ratchet");
  const required = name === "UserPromptSubmit" ? "config.json" : "current";
  if (!fs.existsSync(path.join(state, required))) return null;

  const base = { harness: "claude", session_id: sessionId(hook), cwd };
  const event = build(hook, base);
  if (!event) return null;

  const result = spawnSync(process.execPath, [BIN, "hook"], {
    input: JSON.stringify(event),
    encoding: "utf8",
    cwd,
  });
  let decision;
  try {
    decision = JSON.parse(result.stdout || "{}");
  } catch {
    return null;
  }
  return RESPONSES[name](decision);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const response = handle(raw);
  if (response) process.stdout.write(JSON.stringify(response) + "\n");
});
