// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { toolKind } from "./decide.mjs";
import { isInside, repoRel } from "./fsx.mjs";

const CODE_EXTENSIONS = new Set([
  ".mjs", ".js", ".cjs", ".ts", ".tsx", ".sh", ".py", ".rb", ".go", ".rs", ".bend",
]);

const OUTPUT_LINES = 20;
const POST_TIMEOUT_MS = 60000;

function tailLines(text) {
  return String(text || "").split("\n").slice(-OUTPUT_LINES).join("\n").trimEnd();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function patchTargets(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    let match = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (match) out.push(match[1].trim());
    match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) out.push(match[2].trim());
  }
  return out;
}

function writeTargets(event) {
  const input = event.input ?? {};
  const out = [];
  for (const key of ["path", "filePath", "file_path", "file", "target"]) {
    if (typeof input[key] === "string" && input[key]) out.push(input[key]);
  }
  if (Array.isArray(input.files)) {
    for (const file of input.files) if (typeof file === "string") out.push(file);
  }
  for (const key of ["patch", "command"]) {
    if (typeof input[key] === "string" && input[key].includes("*** ")) out.push(...patchTargets(input[key]));
  }
  return out;
}

function unquoteGitPath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

function gitChanges(root) {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  const out = [];
  for (const line of String(result.stdout || "").split("\n")) {
    if (line.length < 4) continue;
    let target = line.slice(3);
    const arrow = target.indexOf(" -> ");
    if (arrow >= 0) target = target.slice(arrow + 4);
    out.push(unquoteGitPath(target));
  }
  return out;
}

/** Repo-relative code files a tool.after event touched or left dirty. */
export function targetsFor(root, event) {
  const kind = toolKind(event?.tool);
  if (kind !== "write" && kind !== "bash") return [];

  const cwd = event?.cwd || root;
  const candidates =
    kind === "write"
      ? writeTargets(event).map((p) => ({ p, base: cwd }))
      : gitChanges(root).map((p) => ({ p, base: root }));

  const seen = new Set();
  const targets = [];
  for (const { p, base } of candidates) {
    const abs = path.isAbsolute(p) ? p : path.resolve(base, p);
    if (!isInside(root, abs)) continue;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!CODE_EXTENSIONS.has(path.extname(abs).toLowerCase())) continue;
    const rel = repoRel(root, abs);
    if (seen.has(rel)) continue;
    seen.add(rel);
    targets.push(rel);
  }
  return targets;
}

function failureContext(failing) {
  const ids = failing.map((result) => result.id).join(", ");
  const bodies = failing.map((result) => {
    const output = String(result.stderr || "").trim() ? result.stderr : result.stdout;
    return `[${result.id}]\n${output}`;
  });
  return `post checks failed: ${ids}\n${bodies.join("\n")}`.trimEnd();
}

/** Run configured post commands once per event. Never blocks the turn. */
export function runPostChecks(root, event, config) {
  const commands = Array.isArray(config?.post)
    ? config.post.filter((check) => check && typeof check.id === "string" && check.id && typeof check.cmd === "string" && check.cmd)
    : [];
  if (!commands.length) {
    return { ok: true, targets: [], results: [], context: null };
  }
  const targets = targetsFor(root, event);
  if (!targets.length) {
    return { ok: true, targets, results: [], context: null };
  }

  const quoted = targets.map(shellQuote).join(" ");
  const results = commands.map((check) => {
    const cmd = check.cmd.includes("{files}") ? check.cmd.replaceAll("{files}", quoted) : check.cmd;
    const started = Date.now();
    const result = spawnSync("sh", ["-c", cmd], {
      cwd: root,
      encoding: "utf8",
      timeout: POST_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, RATCHET: "1" },
    });
    return {
      id: check.id,
      cmd,
      status: typeof result.status === "number" ? result.status : null,
      durationMs: Date.now() - started,
      stdout: tailLines(result.stdout),
      stderr: tailLines(result.stderr || result.error?.message),
    };
  });

  const failing = results.filter((result) => result.status !== 0);
  return {
    ok: failing.length === 0,
    targets,
    results,
    context: failing.length ? failureContext(failing) : null,
  };
}
