/**
 * OpenCode 1.x adapter. The installer copies this file only when the detected
 * OpenCode major version is below 2.
 *
 * OpenCode 1.x loads a module whose default export is a function returning a
 * hooks object. OpenCode 2.x rejects this shape and needs ratchet.js instead.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WRITE = new Set(["write", "edit", "patch", "multiedit", "apply_patch"]);
const READ = new Set(["read", "grep", "glob", "list", "webfetch", "websearch"]);

function kind(tool) {
  const name = String(tool || "").toLowerCase();
  if (WRITE.has(name)) return "write";
  if (name === "bash" || name === "shell") return "bash";
  if (READ.has(name)) return "read";
  return "other";
}

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

export const RatchetV1 = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    if (!findContractRoot(directory)) return;
    const tool = kind(input?.tool);
    if (tool === "read" || tool === "other") return;

    const payload = {
      harness: "opencode",
      session_id: input?.sessionID ?? null,
      agent: input?.agent ?? null,
      tool,
      input: output?.args ?? {},
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

    // OpenCode 1.x exposes the tool arguments as `output.args`, and mutating
    // them is the documented way to change a call. 2.x uses a different shape;
    // see ratchet.js.
    let decision = null;
    try {
      decision = JSON.parse(result.stdout || "{}");
    } catch {
      decision = null;
    }
    const sandbox = decision?.sandbox;
    if (tool === "bash" && sandbox?.enforced === true && typeof sandbox.command === "string" && sandbox.command) {
      if (output?.args && typeof output.args === "object") output.args.command = sandbox.command;
    }
  },
});
