/**
 * OpenCode 2.x adapter. Install as .opencode/plugins/ratchet.js with:
 * ratchet install --harness opencode --project --yes
 *
 * OpenCode 2.0 replaced the v1 hook object with a default definition whose
 * setup registers hooks imperatively. Throwing from execute.before aborts the
 * tool call and returns the error to the model. Throwing from execute.after
 * returns the post-check failure for the turn.
 *
 * T3 Code runs this adapter when its thread provider is OpenCode. T3's public
 * nightly API has no native prompt/turn hook. Prompt guidance comes from
 * AGENTS.md/skills; the full stop gate is git/CI until a T3 controller exists.
 *
 * MCP tools and subagent calls may bypass this hook in some OpenCode versions,
 * so CI and git remain the authority.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WRITE = new Set(["write", "edit", "patch", "multiedit", "apply_patch"]);
const BASH = new Set(["bash", "shell", "exec", "run"]);
const READ = new Set(["read", "grep", "glob", "list", "webfetch", "websearch"]);

function resolveBin() {
  if (process.env.RATCHET_BIN) return process.env.RATCHET_BIN;
  const local = path.join(process.env.HOME || "", ".local", "bin", "ratchet");
  if (fs.existsSync(local)) return local;
  return "ratchet";
}

function findContractRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet", "current"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function toolKind(name) {
  const lower = String(name || "").toLowerCase();
  if (BASH.has(lower)) return "bash";
  if (WRITE.has(lower)) return "write";
  if (READ.has(lower)) return "read";
  return "other";
}

function runHook(payload, cwd) {
  const bin = resolveBin();
  const result = spawnSync(bin, ["hook"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd,
  });
  if (result.error) return { error: `cannot run "${bin}": ${result.error.message}`, decision: null, status: null, stderr: "" };
  let decision = null;
  try {
    decision = JSON.parse(result.stdout || "{}");
  } catch {
    decision = null;
  }
  return { error: null, decision, status: result.status, stderr: (result.stderr || "").trim() };
}

function reasonOf(result) {
  if (result.decision?.reason) return result.decision.reason;
  return result.stderr.replace(/^\[ratchet\]\s*/, "") || "blocked by ratchet";
}

export default {
  id: "ratchet",
  setup: async (ctx) => {
    const directory =
      ctx.location?.directory ||
      ctx.location?.project?.directory ||
      (typeof ctx.directory === "string" ? ctx.directory : undefined) ||
      (typeof ctx.worktree === "string" ? ctx.worktree : undefined) ||
      process.cwd();

    await ctx.tool.hook("execute.before", (event) => {
      // Global installs must not touch repos without a contract.
      if (!findContractRoot(directory)) return;
      const tool = toolKind(event.tool);
      if (tool === "read" || tool === "other") return;

      const payload = {
        type: "tool.before",
        harness: "opencode",
        session_id: event.sessionID ?? event.session_id ?? null,
        agent: event.agent ?? null,
        tool,
        input: event.input ?? {},
        cwd: directory,
      };
      const result = runHook(payload, directory);
      if (result.error) throw new Error(`[ratchet] ${result.error}`);
      if (result.decision?.allow === false || result.status === 2) {
        throw new Error(`[ratchet] ${reasonOf(result)}`);
      }
    });

    try {
      await ctx.tool.hook("execute.after", (event) => {
        if (!findContractRoot(directory)) return;
        const tool = toolKind(event.tool);
        if (tool === "read" || tool === "other") return;

        const raw = event.result ?? event.output ?? event.response;
        const result =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? raw
            : { ok: event.isError !== true };
        const payload = {
          type: "tool.after",
          harness: "opencode",
          session_id: event.sessionID ?? event.session_id ?? null,
          agent: event.agent ?? null,
          tool,
          input: event.input ?? {},
          result,
          cwd: directory,
        };
        const decision = runHook(payload, directory);
        if (decision.error) return;
        if (typeof decision.decision?.context === "string" && decision.decision.context.trim()) {
          throw new Error(decision.decision.context);
        }
      });
    } catch {
      // Older OpenCode builds may not expose execute.after. The before guard
      // and git/CI still work.
    }

    return () => {};
  },
};
