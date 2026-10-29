// @ts-check
import { APPROVABLE_RULES, classifyBash } from "./classify.mjs";
import { matchesAny, matchesAnyCaseInsensitive } from "./glob.mjs";
import { appendJsonl, readJsonl, stateDir } from "./fsx.mjs";
import { eventsPath, loadRunForSession, normaliseTarget } from "./contract.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const READ_TOOLS = new Set(["read", "grep", "glob", "list", "search", "webfetch", "websearch", "fetch", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "notebookedit", "str_replace"]);
const BASH_TOOLS = new Set(["bash", "shell", "exec", "run"]);

// Scratch files are working state, not task scope. They do not count against
// the file budget, which is why 13 throwaway `web/tmp-*.mjs` probes must not
// look like scope creep.
export function isScratchPath(p) {
  const parts = String(p).split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts.some((part) => part === "tmp" || part === ".tmp" || part === "scratch" || part === ".scratch")) return true;
  if (base === "tmp" || base.endsWith(".tmp")) return true;
  return base.startsWith("tmp-") || base.startsWith("tmp_") || base.startsWith("tmp.");
}

const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", os.tmpdir()];

function realNearest(p) {
  let cur = p;
  for (;;) {
    try {
      return fs.realpathSync.native(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/** A path outside the repo that resolves inside a temp directory. Symlinks are followed. */
function isTempPath(abs) {
  const real = realNearest(abs);
  if (!real) return false;
  return TEMP_ROOTS.some((root) => {
    let realRoot = root;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      // keep the literal root
    }
    return real === realRoot || real.startsWith(realRoot + path.sep);
  });
}

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
    const paths = e.paths ?? [];
    const meaningful = paths.filter((p) => !isScratchPath(p));
    // Scratch-only writes are not task writes. A bash mutation with no resolved
    // path (`git add -A`, `npm install`) is still a write; it just has no files.
    if (paths.length && !meaningful.length) continue;
    writes += 1;
    // Bash paths are inferred from shell text. They are too noisy to charge
    // against the file budget; git is the authority for what bash changed.
    if (BASH_TOOLS.has(String(e.tool).toLowerCase())) continue;
    for (const p of meaningful) files.add(p);
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
    // Bash can be a read. Classify it before refusing, otherwise an idle repo
    // blocks `git status`, `grep`, and `ls` along with real mutations.
    if (kind === "bash") {
      const command = String(event.input?.command ?? "");
      // The gate's own bootstrap: a repo cannot leave the idle state unless
      // this runs. Everything else, including `ratchet disable`, stays denied.
      if (/(?:^|[\s;&|()])ratchet\s+(?:task\s+start|init)\b/.test(command)) {
        return { allow: true, reason: "contract bootstrap", paths: [], op: "write", runId: null };
      }
      const cls = classifyBash(command);
      if (cls.hardDeny) {
        return { allow: false, reason: `Blocked by hard rule: ${cls.reason}.`, paths: [], op: "write", runId: null };
      }
      if (!cls.write) {
        return { allow: true, reason: cls.notes.join("; ") || null, paths: [], op: "read", runId: null };
      }
    }
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
      const approval = (contract.approvals ?? []).find((entry) => entry.rule === cls.hardRule);
      if (!approval) {
        const hint = APPROVABLE_RULES.has(cls.hardRule)
          ? ` If a human approved it for this task, run: ratchet approve --rule ${cls.hardRule} --reason "..."`
          : "";
        return { allow: false, reason: `Blocked by hard rule: ${cls.reason}.${hint}`, paths: [], op: "write", runId: contract.id };
      }
      note = [note, `approved hard rule: ${cls.hardRule} (${approval.reason})`].filter(Boolean).join("; ");
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

  // An interpreter payload that names paths is still unparseable: a redirect in
  // a heredoc can name one in-scope file while the rest of the body writes
  // anywhere. Treat inline code as unresolved even when a path was scraped out.
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

  // A read-only contract means no mutation, however the mutation is expressed:
  // a write tool, a redirect, `rm`, or an unresolved package install.
  if (contract.readOnly) {
    return { allow: false, reason: `Contract ${contract.id} is read-only for role ${contract.role}.`, paths: [], op: "write", runId: contract.id };
  }

  const paths = [...new Set(rawPaths.map((p) => normaliseTarget(root, cwd, p)).filter(Boolean))];
  if (!paths.length) {
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

  // A contract is repo-relative. Paths outside root are refused, except temp
  // files: headless browsers, data probes, and test harnesses legitimately work
  // in /tmp. Symlinks are resolved first, so /tmp/link -> ~/.ssh stays refused.
  const repoPaths = [];
  const tempPaths = [];
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      repoPaths.push(p);
      continue;
    }
    if (isTempPath(p)) {
      tempPaths.push(p);
      continue;
    }
    return { allow: false, reason: `${p} is outside scope: a contract cannot write outside the repository.`, paths, op: "write", runId: contract.id };
  }
  if (tempPaths.length) note = [note, "temp file outside the repo"].filter(Boolean).join("; ");

  // Guard state is not task state. A task that can rewrite the kill switch,
  // the active pointer, or its own contract has no contract at all.
  for (const p of repoPaths) {
    if (matchesAnyCaseInsensitive(p, GUARD_STATE)) {
      return { allow: false, reason: `${p} is guard state and cannot be written by a task.`, paths, op: "write", runId: contract.id };
    }
  }

  for (const p of repoPaths) {
    if (matchesAnyCaseInsensitive(p, deny)) {
      return { allow: false, reason: `${p} is denied by the contract.`, paths, op: "write", runId: contract.id };
    }
  }

  const scope = contract.scope ?? [];
  if (!scope.length) {
    return { allow: false, reason: "Contract has no write scope. Start a task with --scope or use --read-only.", paths, op: "write", runId: contract.id };
  }
  for (const p of repoPaths) {
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
    for (const p of repoPaths) {
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
  // Bash paths are inferred, not observed. Charging them against the file
  // budget turned read-only greps and commit messages into "files". Only
  // explicit write tools and non-scratch paths count.
  if (kind !== "bash") {
    for (const p of repoPaths) if (!isScratchPath(p)) nextFiles.add(p);
  }
  if (nextFiles.size > contract.budgets.maxFiles) {
    return {
      allow: false,
      reason: `File budget exceeded: ${nextFiles.size} > ${contract.budgets.maxFiles}. Escalate instead of widening silently, or start with --max-files.`,
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
  const input = event.input ?? {};
  // A denial with no contract has no run to attach to. Keep it in a repo-level
  // trail so "the gate refused a write while idle" is visible after the fact.
  const file = decision.runId ? eventsPath(root, decision.runId) : path.join(stateDir(root), "events.jsonl");
  appendJsonl(file, {
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
