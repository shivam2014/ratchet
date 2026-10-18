// @ts-check
import { classifyBash } from "./classify.mjs";
import { matchesAny } from "./glob.mjs";
import { appendJsonl, readJsonl } from "./fsx.mjs";
import { eventsPath, loadRun, normaliseTarget } from "./contract.mjs";

const READ_TOOLS = new Set(["read", "grep", "glob", "list", "search", "webfetch", "websearch", "fetch", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "notebookedit", "str_replace"]);
const BASH_TOOLS = new Set(["bash", "shell", "exec", "run"]);

export function toolKind(tool) {
  const name = String(tool || "").toLowerCase();
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  if (BASH_TOOLS.has(name)) return "bash";
  return "other";
}

function patchTargets(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    let m = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (m) out.push(m[1].trim());
    m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) out.push(m[2].trim());
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
    for (const f of input.files) if (typeof f === "string") out.push(f);
  }
  if (typeof input.patch === "string") out.push(...patchTargets(input.patch));
  return out;
}

export function loadState(root, id) {
  const files = new Set();
  let writes = 0;
  for (const e of readJsonl(eventsPath(root, id))) {
    if (e.decision !== "allow" || e.op !== "write") continue;
    writes += 1;
    for (const p of e.paths ?? []) files.add(p);
  }
  return { files, writes };
}

export function decide(root, event) {
  const contract = loadRun(root);
  if (!contract) {
    return {
      allow: false,
      reason: "No active task contract. Run: ratchet task start --role coder --goal \"...\" --scope \"src/**\"",
      paths: [],
      op: "write",
      runId: null,
    };
  }

  const kind = toolKind(event.tool);
  const cwd = event.cwd || root;
  if (kind === "read" || kind === "other") {
    return { allow: true, reason: null, paths: [], op: "read", runId: contract.id };
  }

  if (kind === "write" && contract.readOnly) {
    return { allow: false, reason: `Contract ${contract.id} is read-only for role ${contract.role}.`, paths: [], op: "write", runId: contract.id };
  }

  const rawPaths = [];
  let write = kind === "write";
  let note = null;

  if (kind === "bash") {
    const cls = classifyBash(event.input?.command);
    if (cls.hardDeny) {
      return { allow: false, reason: `Blocked by hard rule: ${cls.reason}.`, paths: [], op: "write", runId: contract.id };
    }
    write = cls.write;
    rawPaths.push(...cls.paths);
    if (cls.notes.length) note = cls.notes.join("; ");
  } else {
    rawPaths.push(...writeTargets(event));
  }

  if (!write) {
    return { allow: true, reason: note, paths: [], op: "read", runId: contract.id };
  }

  const paths = [...new Set(rawPaths.map((p) => normaliseTarget(root, cwd, p)).filter(Boolean))];
  if (!paths.length) {
    // Coarse guard: a mutation we cannot locate. Allow it, but record that it
    // was unresolved so the audit trail shows the gap.
    return { allow: true, reason: note ? `unresolved target (${note})` : "unresolved target", paths: [], op: "write", runId: contract.id, unresolved: true };
  }

  const deny = contract.deny ?? [];
  for (const p of paths) {
    if (matchesAny(p, deny)) {
      return { allow: false, reason: `${p} is denied by the contract.`, paths, op: "write", runId: contract.id };
    }
  }

  const scope = contract.scope ?? [];
  if (!scope.length) {
    return { allow: false, reason: "Contract has no write scope. Start a task with --scope or use --read-only.", paths, op: "write", runId: contract.id };
  }
  for (const p of paths) {
    if (!matchesAny(p, scope)) {
      return {
        allow: false,
        reason: `${p} is outside scope [${scope.join(", ")}]. If it is genuinely needed, start a new task contract with a wider --scope.`,
        paths,
        op: "write",
        runId: contract.id,
      };
    }
  }

  const state = loadState(root, contract.id);
  const nextFiles = new Set(state.files);
  for (const p of paths) nextFiles.add(p);
  if (nextFiles.size > contract.budgets.maxFiles) {
    return {
      allow: false,
      reason: `File budget exceeded: ${nextFiles.size} > ${contract.budgets.maxFiles}. Escalate instead of widening silently.`,
      paths,
      op: "write",
      runId: contract.id,
    };
  }
  if (state.writes + 1 > contract.budgets.maxWrites) {
    return {
      allow: false,
      reason: `Write budget exceeded: ${state.writes + 1} > ${contract.budgets.maxWrites}.`,
      paths,
      op: "write",
      runId: contract.id,
    };
  }

  return { allow: true, reason: note, paths, op: "write", runId: contract.id };
}

/** Persist the decision, with file content redacted to a length. */
export function record(root, event, decision) {
  if (!decision.runId) return;
  const input = event.input ?? {};
  appendJsonl(eventsPath(root, decision.runId), {
    ts: new Date().toISOString(),
    harness: event.harness ?? "unknown",
    session_id: event.session_id ?? null,
    agent: event.agent ?? null,
    tool: event.tool ?? "unknown",
    op: decision.op,
    paths: decision.paths ?? [],
    decision: decision.allow ? "allow" : "deny",
    reason: decision.reason ?? null,
    unresolved: Boolean(decision.unresolved),
    content_length: typeof input.content === "string" ? input.content.length : undefined,
    command: typeof input.command === "string" ? input.command.slice(0, 500) : undefined,
  });
}
