/**
 * OpenCode 2.x adapter. Install as .opencode/plugins/ratchet.js with:
 * ratchet install --harness opencode --project --yes
 *
 * OpenCode 2.0 replaced the v1 hook object with a default definition whose
 * setup registers hooks imperatively. Throwing from execute.before aborts the
 * tool call and returns the error to the model.
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
      const name = String(event.tool || "").toLowerCase();
      let tool = "other";
      if (BASH.has(name)) tool = "bash";
      else if (WRITE.has(name)) tool = "write";
      else if (READ.has(name)) return;
      else return;

      const payload = {
        harness: "opencode",
        session_id: event.sessionID ?? event.session_id ?? null,
        agent: event.agent ?? null,
        tool,
        input: event.input ?? {},
        cwd: directory,
      };
      const bin = resolveBin();
      const result = spawnSync(bin, ["guard"], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        cwd: directory,
      });
      if (result.error) {
        throw new Error(`[ratchet] cannot run "${bin}": ${result.error.message}`);
      }
      if (result.status === 2) {
        throw new Error((result.stderr || result.stdout || "").trim() || "[ratchet] blocked by task contract");
      }
    });

    return () => {};
  },
};
