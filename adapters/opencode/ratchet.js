/**
 * OpenCode adapter. Install as .opencode/plugins/ratchet.js with:
 * ratchet install --harness opencode --project --yes
 *
 * OpenCode calls this before built-in tools. Throwing aborts the tool call and
 * returns the message to the model. MCP tools and subagent calls may bypass
 * this hook in some OpenCode versions, so CI and git remain the authority.
 */
import { spawnSync } from "node:child_process";

const WRITE = new Set(["write", "edit", "patch", "multiedit", "apply_patch"]);
const READ = new Set(["read", "grep", "glob", "list", "webfetch", "websearch"]);

function kind(tool) {
  const name = String(tool || "").toLowerCase();
  if (WRITE.has(name)) return "write";
  if (name === "bash" || name === "shell") return "bash";
  if (READ.has(name)) return "read";
  return "other";
}

export const Ratchet = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    const tool = kind(input?.tool);
    if (tool === "read" || tool === "other") return;

    const event = {
      harness: "opencode",
      session_id: input?.sessionID ?? null,
      agent: input?.agent ?? null,
      tool,
      input: output?.args ?? {},
      cwd: directory,
    };

    const bin = process.env.RATCHET_BIN || "ratchet";
    const result = spawnSync(bin, ["guard"], {
      input: JSON.stringify(event),
      encoding: "utf8",
      cwd: directory,
    });

    if (result.error) {
      throw new Error(`[ratchet] cannot run "${bin}": ${result.error.message}. Install the CLI or set RATCHET_BIN.`);
    }
    if (result.status === 2) {
      const reason = (result.stderr || result.stdout || "").trim();
      throw new Error(reason || "[ratchet] blocked by task contract");
    }
  },
});
