// @ts-check
import { writeJson } from "./fsx.mjs";
import { runShell } from "./platform.mjs";
import { checksPath } from "./contract.mjs";

const TAIL = 4000;
const FAILURE_LINES = 60;

function tail(text) {
  const s = String(text || "");
  return s.length > TAIL ? s.slice(s.length - TAIL) : s;
}

function failureContext(text) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith("not ok"));
  if (start < 0) return null;
  return lines.slice(start, start + FAILURE_LINES).join("\n");
}

export function runChecks(root, checks, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 120000);
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    const r = runShell(check.cmd, {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, RATCHET: "1" },
    });
    results.push({
      id: check.id,
      cmd: check.cmd,
      status: r.status,
      signal: r.signal ?? null,
      durationMs: Date.now() - started,
      failure: failureContext(r.stdout) ?? failureContext(r.stderr),
      stdout: tail(r.stdout),
      stderr: tail(r.stderr || r.error?.message),
    });
  }
  return {
    ok: results.length > 0 && results.every((r) => r.status === 0),
    empty: results.length === 0,
    ranAt: new Date().toISOString(),
    results,
  };
}

export function saveChecks(root, id, report) {
  writeJson(checksPath(root, id), report);
}
