#!/usr/bin/env node
/**
 * Codex CLI lifecycle adapter for UserPromptSubmit, PreToolUse, PostToolUse,
 * and Stop.
 *
 * Safe to install globally: outside a repo with a `.ratchet` directory every
 * event exits 0 without output, so unrelated projects stay untouched. Prompt
 * events need `.ratchet/config.json`; tool and stop events need an active
 * `.ratchet/current` contract. Inside a Ratchet repo the raw hook JSON becomes
 * a normalized `ratchet hook` event and the decision is translated back to the
 * shape Codex expects for that event.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN =
  process.env.RATCHET_BIN ||
  path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");

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

function firstNumber(...values) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

/** Codex reports command failures in more than one shape; the trail needs ok/exit. */
function toolResult(raw) {
  const response = raw.tool_response ?? raw.tool_result ?? raw.tool_output;
  if (typeof response === "string") return { ok: true };
  const object = asObject(response);
  if (typeof object.is_error === "boolean") return { ok: !object.is_error };
  if (typeof object.success === "boolean") return { ok: object.success };
  const metadata = asObject(object.metadata);
  const exit = firstNumber(object.exit, object.exit_code, object.exitCode, metadata.exit, metadata.exit_code, metadata.exitCode);
  if (exit !== undefined) return { ok: exit === 0, exit };
  return { ok: true };
}

/** Codex names tools differently from Ratchet's normalized kinds. */
function toolInput(raw) {
  const name = typeof raw.tool_name === "string" ? raw.tool_name : "";
  const kind = name.toLowerCase();
  const input = asObject(raw.tool_input);
  if (kind === "bash" || kind === "shell") {
    return { tool: "bash", input: { command: input.command ?? "" } };
  }
  if (kind === "apply_patch" || kind === "patch") {
    return { tool: "write", input: { patch: input.command || input.patch || "" } };
  }
  if (kind === "edit" || kind === "write" || kind === "multiedit") {
    const target = input.path ?? input.file_path ?? input.filePath ?? input.file;
    const normalized = {};
    if (typeof target === "string" && target) normalized.path = target;
    if (typeof input.content === "string") normalized.content = input.content;
    return { tool: "write", input: normalized };
  }
  return { tool: name || "other", input };
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
    const mapped = toolInput(raw);
    return { ...base, type: "tool.before", tool: mapped.tool, input: mapped.input };
  },
  PostToolUse(raw, base) {
    if (typeof raw.tool_name !== "string" || !raw.tool_name) return null;
    const mapped = toolInput(raw);
    return { ...base, type: "tool.after", tool: mapped.tool, input: mapped.input, result: toolResult(raw) };
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

function runHook(event, cwd) {
  const result = spawnSync(process.execPath, [BIN, "hook"], {
    input: JSON.stringify(event),
    encoding: "utf8",
    cwd,
  });
  if (result.error) return { error: result.error };
  try {
    return { decision: JSON.parse(result.stdout || "{}") };
  } catch {
    return { error: new Error("ratchet hook returned invalid JSON") };
  }
}

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

  const cwd = typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd();
  const root = findRatchetRoot(cwd);
  if (!root) return null;
  const state = path.join(root, ".ratchet");
  const required = name === "UserPromptSubmit" ? "config.json" : "current";
  if (!fs.existsSync(path.join(state, required))) return null;

  const base = { harness: "codex", session_id: sessionId(hook), cwd };
  const event = EVENTS[name](hook, base);
  if (!event) return null;

  const result = runHook(event, cwd);
  if (result.error) {
    if (name === "PreToolUse") {
      return RESPONSES.PreToolUse({ allow: false, reason: `ratchet hook failed: ${result.error.message}` });
    }
    return null;
  }
  return RESPONSES[name](result.decision);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const response = handle(raw);
  if (response) process.stdout.write(JSON.stringify(response) + "\n");
});
