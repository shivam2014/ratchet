/**
 * OpenCode 2.x adapter. Install as .opencode/plugins/ratchet.js with:
 * ratchet install --harness opencode --project --yes
 *
 * The installed OpenCode runtime (2.1.x, including the service T3 Code uses)
 * loads a plugin module that exports a default definition with an `id` and a
 * `setup` function. `setup` registers tool hooks through `ctx.tool.hook`;
 * throwing from `execute.before` aborts the call and returns the error to the
 * model.
 *
 * T3 Code hosts every thread in one OpenCode instance whose directory is the
 * app workspace (often $HOME). Resolving the repo from `ctx.directory` alone
 * therefore guards nothing in T3: the home directory has no `.ratchet`, so the
 * plugin no-ops on every call. Resolve the repo from each call's target path
 * or workdir instead.
 *
 * A repo counts as ratchet-enabled when it has `.ratchet/config.json`, not only
 * when a contract is live. That way a write in an idle ratchet repo reaches the
 * guard and is denied with "No active task contract" instead of slipping
 * through until the next `task start`.
 *
 * MCP tools and subagent calls may bypass this hook in some OpenCode versions,
 * so CI and git remain the authority.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WRITE = new Set(["write", "edit", "patch", "multiedit", "apply_patch", "notebookedit", "str_replace"]);
const BASH = new Set(["bash", "shell", "exec", "run"]);
const READ = new Set(["read", "grep", "glob", "list", "webfetch", "websearch", "fetch", "ls"]);
const TARGET_KEYS = ["filePath", "file_path", "path", "file", "target"];

function resolveBin() {
  if (process.env.RATCHET_BIN) return process.env.RATCHET_BIN;
  const local = path.join(process.env.HOME || "", ".local", "bin", "ratchet");
  if (fs.existsSync(local)) return local;
  return "ratchet";
}

function toolKind(name) {
  const lower = String(name || "").toLowerCase();
  if (BASH.has(lower)) return "bash";
  if (WRITE.has(lower)) return "write";
  if (READ.has(lower)) return "read";
  return "other";
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Walk up from a file or directory to the nearest ratchet-enabled repo. */
function findRepoRoot(start) {
  let dir = path.resolve(start || process.cwd());
  if (isFile(dir)) dir = path.dirname(dir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every path a call may touch, resolved against the session directory. */
function targetsOf(tool, args, base) {
  const out = [];
  for (const key of TARGET_KEYS) {
    if (typeof args[key] === "string" && args[key]) out.push(path.resolve(base, args[key]));
  }
  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      if (typeof file === "string" && file) out.push(path.resolve(base, file));
    }
  }
  if (tool === "bash") {
    const cwd = args.workdir || args.cwd || args.directory;
    if (typeof cwd === "string" && cwd) out.push(path.resolve(base, cwd));
    const command = String(args.command ?? "");
    const cd = command.match(/(?:^|[\s;&|])cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/);
    if (cd) out.push(path.resolve(base, cd[1].replace(/^["']|["']$/g, "")));
    // Commands often carry absolute paths (`node /repo/script.mjs`,
    // `> /repo/out.txt`) without a workdir. Treat each as a candidate root.
    for (const token of command.split(/[\s;&|()<>]+/)) {
      const cleaned = token.replace(/^["']|["']$/g, "");
      if (cleaned.startsWith("/")) out.push(cleaned);
      else if (cleaned.startsWith("~/")) out.push(path.join(process.env.HOME || "", cleaned.slice(2)));
    }
  }
  return out;
}

/**
 * The repo this call belongs to: the nearest configured root among its
 * targets, else the session directory. Null means "no ratchet here", the only
 * case a global install stays silent.
 */
function rootFor(tool, args, base) {
  for (const target of targetsOf(tool, args, base)) {
    const root = findRepoRoot(target);
    if (root) return root;
  }
  return findRepoRoot(base);
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

function payloadFor(type, tool, event, args, root) {
  return {
    type,
    harness: "opencode",
    session_id: event.sessionID ?? event.session_id ?? null,
    agent: event.agent ?? null,
    tool,
    input: args,
    cwd: root,
    ...(type === "tool.after" ? { result: { ok: event.isError !== true } } : {}),
  };
}

export default {
  id: "ratchet",
  setup: async (ctx) => {
    const homes = [
      ctx?.location?.directory,
      ctx?.location?.project?.directory,
      typeof ctx?.worktree === "string" ? ctx.worktree : null,
      typeof ctx?.directory === "string" ? ctx.directory : null,
    ].filter((value) => typeof value === "string" && value);
    const fallback = homes[0] ?? process.cwd();

    const baseFor = (event, args) => event.cwd ?? args.workdir ?? fallback;

    await ctx.tool.hook("execute.before", (event) => {
      const tool = toolKind(event?.tool);
      if (tool === "read" || tool === "other") return;

      const args = event?.input ?? {};
      const root = rootFor(tool, args, baseFor(event, args));
      // No .ratchet/config.json anywhere in this call's path: another agent's
      // repo, or a plain directory. Stay out of it.
      if (!root) return;

      // Bootstrapping a contract is how an idle repo leaves the idle state.
      // Only allow it while idle: with a live contract, `task start --force`
      // would let one thread abandon another thread's contract.
      if (
        tool === "bash" &&
        !fs.existsSync(path.join(root, ".ratchet", "current")) &&
        /(?:^|[\s;&|()])ratchet\s+(?:task\s+start|init)\b/.test(String(args.command ?? ""))
      ) return;

      const result = runHook(payloadFor("tool.before", tool, event, args, root), root);
      if (result.error) throw new Error(`[ratchet] ${result.error}`);
      // Fail closed. Only an exit-0 response that explicitly allows the call
      // opens the door; a crash (exit 1), a deny (exit 2), or unparseable
      // output blocks.
      if (result.status !== 0 || result.decision?.allow !== true) {
        const detail = result.decision?.reason ?? result.stderr.replace(/^\[ratchet\]\s*/, "");
        const reason = detail || (result.status === 0 ? "guard returned no decision" : `guard exited ${result.status} without a decision`);
        throw new Error(`[ratchet] ${reason}`);
      }
    });

    try {
      await ctx.tool.hook("execute.after", (event) => {
        const tool = toolKind(event?.tool);
        if (tool === "read" || tool === "other") return;

        const args = event?.input ?? {};
        const root = rootFor(tool, args, baseFor(event, args));
        if (!root) return;

        const result = runHook(payloadFor("tool.after", tool, event, args, root), root);
        if (result.error) return;
        if (typeof result.decision?.context === "string" && result.decision.context.trim()) {
          throw new Error(result.decision.context);
        }
      });
    } catch {
      // Older OpenCode builds may not expose execute.after. The before guard
      // and git/CI still work.
    }

    return () => {};
  },
};
