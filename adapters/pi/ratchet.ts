/**
 * pi adapter for prompt, tool, result, and stop events. Add to a project
 * extension directory or load from ~/.pi/agent/extensions/ratchet.ts. Spawns
 * the CLI so the policy has one owner.
 *
 * Safe to install globally: prompt events need `.ratchet/config.json` and the
 * rest need an active `.ratchet/current` contract. Outside those, every
 * handler returns without spawning the CLI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WRITE = new Set(["write", "edit"]);
const READ = new Set(["read", "grep", "find", "ls", "glob"]);
const CUSTOM_TYPE = "ratchet";

function kind(tool: string) {
  if (WRITE.has(tool)) return "write";
  if (tool === "bash") return "bash";
  if (READ.has(tool)) return "read";
  return "other";
}

function resolveBin() {
  if (process.env.RATCHET_BIN) return process.env.RATCHET_BIN;
  const local = path.join(process.env.HOME || "", ".local", "bin", "ratchet");
  if (fs.existsSync(local)) return local;
  return "ratchet";
}

/** Nearest ancestor `.ratchet` state file. Prompt events need config.json; the rest need current. */
function hasState(cwd: string, file: string) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet", file))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function sessionId(ctx: any) {
  const value = ctx?.sessionManager?.getSessionId?.();
  return typeof value === "string" && value ? value : "unknown";
}

/** pi reports bash failures through isError and structuredContent.exit_code. */
function toolResult(event: any) {
  const exit = event?.structuredContent?.exit_code;
  if (typeof exit === "number" && Number.isFinite(exit)) return { ok: exit === 0, exit };
  return { ok: !event?.isError };
}

function lastAssistantText(messages: any[]) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

function runHook(event: Record<string, unknown>, cwd: string) {
  const bin = resolveBin();
  const result = spawnSync(bin, ["hook"], {
    input: JSON.stringify(event),
    encoding: "utf8",
    cwd,
  });
  if (result.error) return { error: `cannot run "${bin}": ${result.error.message}`, decision: null, status: null, stderr: "" };
  let decision: any = null;
  try {
    decision = JSON.parse(result.stdout || "{}");
  } catch {
    decision = null;
  }
  return { decision, status: result.status, stderr: (result.stderr || "").trim() };
}

function failureText(decision: any, stderr: string) {
  if (typeof decision?.reason === "string" && decision.reason.trim()) return decision.reason;
  return stderr.replace(/^\[ratchet\]\s*/, "") || "blocked by ratchet";
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user" || typeof event.prompt !== "string") return;
    const cwd = ctx.cwd ?? process.cwd();
    if (!hasState(cwd, "config.json")) return;

    const result = runHook(
      {
        type: "prompt.submit",
        harness: "pi",
        session_id: sessionId(ctx),
        prompt: event.prompt,
        cwd,
      },
      cwd,
    );
    if (result.error) return;

    const context = result.decision?.context;
    if (typeof context !== "string" || !context.trim()) return;
    if (event.systemPrompt.includes(context)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    const tool = kind(event.toolName);
    if (tool === "read" || tool === "other") return;

    const cwd = ctx.cwd ?? process.cwd();
    // Global installs must not touch repos without a contract.
    if (!hasState(cwd, "current")) return;

    const result = runHook(
      {
        type: "tool.before",
        harness: "pi",
        session_id: sessionId(ctx),
        tool,
        input: event.input,
        cwd,
      },
      cwd,
    );

    if (result.error) return { block: true, reason: `[ratchet] ${result.error}` };
    if (result.decision?.allow !== false && result.status !== 2) return;
    const reason = result.decision?.allow === false
      ? `[ratchet] ${failureText(result.decision, result.stderr)}`
      : result.stderr || "[ratchet] blocked by ratchet";
    return { block: true, reason };
  });

  pi.on("tool_result", async (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (!hasState(cwd, "current")) return;

    const result = runHook(
      {
        type: "tool.after",
        harness: "pi",
        session_id: sessionId(ctx),
        tool: kind(event.toolName),
        input: event.input ?? {},
        result: toolResult(event),
        cwd,
      },
      cwd,
    );
    if (result.error) return;

    const context = result.decision?.context;
    if (typeof context !== "string" || !context.trim()) return;
    pi.sendMessage({ customType: CUSTOM_TYPE, content: context, display: true }, { triggerTurn: true });
  });

  pi.on("agent_end", async (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (!hasState(cwd, "current")) return;

    const lastMessage = lastAssistantText(event.messages);
    const result = runHook(
      {
        type: "turn.stop",
        harness: "pi",
        session_id: sessionId(ctx),
        cwd,
        ...(lastMessage ? { last_message: lastMessage } : {}),
      },
      cwd,
    );
    if (result.error || result.decision?.allow !== false) return;

    pi.sendMessage(
      {
        customType: CUSTOM_TYPE,
        content: `[ratchet] ${failureText(result.decision, result.stderr)}`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });
}
