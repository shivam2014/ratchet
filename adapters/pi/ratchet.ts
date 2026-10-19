/**
 * pi adapter. Add to a project extension directory or load from
 * ~/.pi/agent/extensions/ratchet.ts. Spawns the CLI so the policy has one owner.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WRITE = new Set(["write", "edit"]);
const READ = new Set(["read", "grep", "find", "ls", "glob"]);

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

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const tool = kind(event.toolName);
    if (tool === "read" || tool === "other") return;

    const cwd = (ctx as any)?.cwd ?? process.cwd();
    // Global installs must not touch repos without a contract.
    let dir = path.resolve(cwd);
    let hasContract = false;
    for (;;) {
      if (fs.existsSync(path.join(dir, ".ratchet", "current"))) {
        hasContract = true;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!hasContract) return;

    const payload = {
      harness: "pi",
      session_id: (ctx as any)?.sessionManager?.getSessionId?.() ?? null,
      agent: null,
      tool,
      input: event.input,
      cwd,
    };
    const bin = resolveBin();
    const result = spawnSync(bin, ["guard"], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd,
    });

    if (result.error) {
      return { block: true, reason: `[ratchet] cannot run "${bin}": ${result.error.message}` };
    }
    if (result.status === 2) {
      return { block: true, reason: (result.stderr || result.stdout || "").trim() };
    }
  });
}
