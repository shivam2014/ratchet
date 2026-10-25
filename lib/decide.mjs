// @ts-check
import { classifyBash } from "./classify.mjs";
import { matchesAny, matchesAnyCaseInsensitive } from "./glob.mjs";
import { appendJsonl, readJsonl } from "./fsx.mjs";
import { eventsPath, loadRunForSession, normaliseTarget } from "./contract.mjs";
import fs from "node:fs";
import path from "node:path";

const READ_TOOLS = new Set(["read", "grep", "glob", "list", "search", "webfetch", "websearch", "fetch", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "notebookedit", "str_replace"]);
const BASH_TOOLS = new Set(["bash", "shell", "exec", "run"]);

// Files that control the guard itself. Gate artifacts (for example
// .ratchet/plan.md) stay writable; these do not.
const GUARD_STATE = [
  ".ratchet/current",
  ".ratchet/disabled.json",
  ".ratchet/config.json",
  ".ratchet/install.json",
  ".ratchet/rules.tsv",
  ".ratchet/runs/**",
];

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
    m = line.match(/^\*\*\* Move to:\s*(.+)$/);
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
  const kind = toolKind(event.tool);
  const contract = loadRunForSession(root, event.session_id);

  // Reads never mutate, so they are allowed even with no contract.
  if (kind === "read" || kind === "other") {
    return { allow: true, reason: null, paths: [], op: "read", runId: contract?.id ?? null };
  }

  if (!contract) {
    return {
      allow: false,
      reason: "No active task contract. Run: ratchet task start --role coder --goal \"...\" --scope \"src/**\"",
      paths: [],
      op: "write",
      runId: null,
    };
  }

  const rawPaths = [];
  const cwd = event.cwd || root;
  let write = kind === "write";
  let inline = false;
  let note = null;

  if (kind === "bash") {
    const cls = classifyBash(event.input?.command);
    if (cls.hardDeny) {
      return { allow: false, reason: `Blocked by hard rule: ${cls.reason}.`, paths: [], op: "write", runId: contract.id };
    }
    write = cls.write;
    inline = Boolean(cls.inline);
    rawPaths.push(...cls.paths);
    if (cls.notes.length) note = cls.notes.join("; ");
  } else {
    rawPaths.push(...writeTargets(event));
  }

  if (!write) {
    return { allow: true, reason: note, paths: [], op: "read", runId: contract.id };
  }

  // A read-only contract means no mutation, however the mutation is expressed:
  // a write tool, a redirect, `rm`, or an unresolved package install.
  if (contract.readOnly) {
    return { allow: false, reason: `Contract ${contract.id} is read-only for role ${contract.role}.`, paths: [], op: "write", runId: contract.id };
  }

  const paths = [...new Set(rawPaths.map((p) => normaliseTarget(root, cwd, p)).filter(Boolean))];
  if (!paths.length) {
    if (kind === "bash" && inline) {
      return {
        allow: false,
        reason:
          "Inline interpreter code cannot be checked against the scope. Put the code in a file inside the scope and run that file.",
        paths: [],
        op: "write",
        runId: contract.id,
      };
    }
    if (kind === "write") {
      return {
        allow: false,
        reason: "Cannot resolve a write target. The tool event must include a path.",
        paths: [],
        op: "write",
        runId: contract.id,
      };
    }
    // Bash is coarser: a mutation we cannot locate (npm install, tar, …) is
    // allowed but recorded as unresolved so the audit trail shows the gap.
    return { allow: true, reason: note ? `unresolved target (${note})` : "unresolved target", paths: [], op: "write", runId: contract.id, unresolved: true };
  }

  const deny = contract.deny ?? [];

  // A contract is repo-relative. normaliseTarget returns an absolute path when
  // the target resolves outside root (including through a symlink), and a `**`
  // scope would otherwise match that absolute path.
  for (const p of paths) {
    if (path.isAbsolute(p)) {
      return { allow: false, reason: `${p} is outside scope: a contract cannot write outside the repository.`, paths, op: "write", runId: contract.id };
    }
  }

  // Guard state is not task state. A task that can rewrite the kill switch,
  // the active pointer, or its own contract has no contract at all.
  for (const p of paths) {
    if (matchesAnyCaseInsensitive(p, GUARD_STATE)) {
      return { allow: false, reason: `${p} is guard state and cannot be written by a task.`, paths, op: "write", runId: contract.id };
    }
  }

  for (const p of paths) {
    if (matchesAnyCaseInsensitive(p, deny)) {
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

  // Skill-order gates. A gate declares an artifact that must exist before a
  // pattern is writable. This is how a pstack skill stops being advice.
  for (const gate of contract.gates ?? []) {
    if (!gate?.artifact || !Array.isArray(gate.before) || !gate.before.length) continue;
    if (fs.existsSync(path.join(root, gate.artifact))) continue;
    for (const p of paths) {
      // The artifact is the way out of the gate; writing it must stay allowed.
      if (p === gate.artifact) continue;
      if (matchesAny(p, gate.before)) {
        return {
          allow: false,
          reason: `Skill gate: ${gate.message || `write ${gate.artifact} first`} [missing ${gate.artifact}]`,
          paths,
          op: "write",
          runId: contract.id,
          gate: gate.artifact,
        };
      }
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
    disabled: Boolean(decision.disabled),
    gate: decision.gate ?? undefined,
    content_length: typeof input.content === "string" ? input.content.length : undefined,
    command: typeof input.command === "string" ? input.command.slice(0, 500) : undefined,
  });
}
