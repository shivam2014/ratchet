#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appendJsonl,
  ensureDir,
  findRoot,
  readJson,
  readJsonl,
  readText,
  repoRel,
  slug,
  stateDir,
  timestampId,
  writeJson,
  writeText,
} from "../lib/fsx.mjs";
import {
  checksPath,
  configPath,
  createContract,
  currentId,
  defaultConfig,
  detectChecks,
  eventsPath,
  loadConfig,
  loadRun,
  runDir,
  saveConfig,
  saveContract,
} from "../lib/contract.mjs";
import { decide, loadState, record } from "../lib/decide.mjs";
import { runChecks, saveChecks } from "../lib/checks.mjs";
import { auditRules } from "../lib/rules.mjs";

const BOOLEAN = new Set(["force", "read-only", "json", "check", "install", "all", "help", "version"]);

function parseArgs(argv) {
  const positional = [];
  /** @type {Record<string, string[]|boolean[]>} */
  const flags = {};
  const add = (key, value) => {
    flags[key] ??= [];
    /** @type {any[]} */ (flags[key]).push(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      add(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN.has(body)) {
      add(body, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      add(body, true);
    } else {
      add(body, next);
      i++;
    }
  }
  return {
    positional,
    has: (k) => Boolean(flags[k]),
    one: (k, fallback = undefined) => {
      const v = flags[k];
      return Array.isArray(v) ? v[v.length - 1] : fallback;
    },
    all: (k) => {
      const v = flags[k];
      if (!v) return [];
      return /** @type {any[]} */ (v).filter((x) => typeof x === "string");
    },
  };
}

function out(text = "") {
  process.stdout.write(text + "\n");
}

function fail(text, code = 1) {
  process.stderr.write(text + "\n");
  process.exit(code);
}

function requireConfig(root) {
  const config = loadConfig(root);
  if (!config) fail(`No .ratchet/config.json at ${root}. Run: ratchet init`);
  return config;
}

function requireContract(root) {
  const contract = loadRun(root);
  if (!contract) fail("No active task contract. Run: ratchet task start --role coder --goal \"...\" --scope \"src/**\"");
  return contract;
}

function relativeToRoot(root, p) {
  return repoRel(root, path.resolve(root, p));
}

function commandInit(args) {
  const root = path.resolve(String(args.one("root", process.cwd())));
  const exists = fs.existsSync(configPath(root));
  if (exists && !args.has("force")) {
    fail(`.ratchet/config.json already exists at ${root}. Use --force to replace it.`);
  }
  const config = defaultConfig(root);
  saveConfig(root, config);
  ensureDir(path.join(stateDir(root), "runs"));
  writeText(path.join(stateDir(root), ".gitignore"), "runs/\nlast-check.json\n");
  const rules = path.join(stateDir(root), "rules.tsv");
  if (!fs.existsSync(rules)) writeText(rules, "rule\tlayer\tenforcer\tproof\n");
  out(`ratchet init: ${root}`);
  out(`checks: ${config.checks.length ? config.checks.map((c) => c.id).join(", ") : "none detected"}`);
  out("");
  out("next:");
  out(`  ratchet task start --role coder --goal "what you are changing" --scope "src/**"`);
  out("  ratchet check");
  out("  ratchet done");
}

function commandTask(args) {
  const sub = args.positional[0];
  const root = findRoot(process.cwd());
  const config = requireConfig(root);

  if (sub === "status") {
    const contract = requireContract(root);
    const state = loadState(root, contract.id);
    const checks = readJson(checksPath(root, contract.id), null);
    out(`run:     ${contract.id}`);
    out(`goal:    ${contract.goal}`);
    out(`role:    ${contract.role}${contract.readOnly ? " (read-only)" : ""}`);
    out(`scope:   ${contract.scope.join(", ") || "(none)"}`);
    out(`budgets: ${state.files.size}/${contract.budgets.maxFiles} files, ${state.writes}/${contract.budgets.maxWrites} writes`);
    out(`checks:  ${checks ? (checks.ok ? "pass" : "fail") + " (" + checks.ranAt + ")" : "not run"}`);
    return;
  }

  if (sub !== "start") fail("usage: ratchet task start --role coder --goal \"...\" --scope \"src/**\"");

  const goal = String(args.one("goal", args.positional.slice(1).join(" ")) || "").trim();
  if (!goal) fail("task start needs --goal \"...\"");
  const role = String(args.one("role", "coder"));
  const readOnly = args.has("read-only") || role === "reviewer" || role === "scout";
  const scope = args.all("scope").length ? args.all("scope") : config.defaults?.scope ?? [];
  if (!readOnly && !scope.length) {
    fail('task start needs --scope (for example --scope "src/**" --scope "tests/**"), or pass --read-only.');
  }
  const deny = [...(config.defaults?.deny ?? []), ...args.all("deny")];
  const contract = createContract(root, {
    goal,
    role,
    readOnly,
    scope,
    deny,
    maxFiles: Number(args.one("max-files", config.defaults?.maxFiles ?? 12)),
    maxWrites: Number(args.one("max-writes", config.defaults?.maxWrites ?? 60)),
    verify: args.all("verify").length
      ? args.all("verify")
      : (config.checks ?? []).map((c) => c.cmd),
  });
  saveContract(root, contract);
  out(`run:     ${contract.id}`);
  out(`contract ${path.join(runDir(root, contract.id), "contract.json")}`);
  out(`scope:   ${contract.scope.join(", ")}`);
  out(`budgets: ${contract.budgets.maxFiles} files, ${contract.budgets.maxWrites} writes`);
  out(`verify:  ${contract.verify.map((v) => v.cmd).join(" && ") || "(none)"}`);
}

function normaliseEvent(raw) {
  if (raw && typeof raw.tool_name === "string") {
    return {
      harness: "claude",
      tool: raw.tool_name,
      input: raw.tool_input ?? {},
      cwd: raw.cwd,
      session_id: raw.session_id,
      agent: raw.agent_type ?? null,
    };
  }
  return {
    harness: raw?.harness ?? "unknown",
    tool: raw?.tool ?? "unknown",
    input: raw?.input ?? raw?.args ?? {},
    cwd: raw?.cwd,
    session_id: raw?.session_id ?? raw?.sessionID ?? null,
    agent: raw?.agent ?? null,
  };
}

function claudeDecision(decision) {
  if (decision.allow) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[ratchet] ${decision.reason}`,
    },
  });
}

function commandGuard(args) {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) fail("guard expects a JSON event on stdin");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("guard: stdin is not valid JSON");
  }
  const event = normaliseEvent(parsed);
  const root = findRoot(event.cwd || process.cwd());
  const decision = decide(root, event);
  record(root, event, decision);

  const format = String(args.one("format", "default"));
  if (format === "claude") {
    const text = claudeDecision(decision);
    if (text) out(text);
    process.exit(0);
  }
  if (format === "json") {
    out(JSON.stringify(decision));
    process.exit(0);
  }
  out(JSON.stringify(decision));
  if (!decision.allow) {
    process.stderr.write(`[ratchet] ${decision.reason}\n`);
    process.exit(2);
  }
}

function commandCheck(args) {
  const root = findRoot(process.cwd());
  const config = requireConfig(root);
  const contract = loadRun(root);
  const checks = contract?.verify.length ? contract.verify : config.checks ?? [];
  if (!checks.length) fail("No checks configured. Add them to .ratchet/config.json or pass --verify at task start.");
  const report = runChecks(root, checks, { timeoutMs: Number(args.one("timeout", 120000)) });
  if (contract) saveChecks(root, contract.id, report);
  else writeJson(path.join(stateDir(root), "last-check.json"), report);
  for (const r of report.results) {
    out(`${r.status === 0 ? "PASS" : "FAIL"}  ${r.id}  (${(r.durationMs / 1000).toFixed(1)}s)`);
    if (r.status !== 0) {
      if (r.stdout) out(r.stdout.split("\n").slice(-20).join("\n"));
      if (r.stderr) out(r.stderr.split("\n").slice(-20).join("\n"));
    }
  }
  if (report.empty) out("no checks ran");
  process.exit(report.ok ? 0 : 1);
}

function gitFacts(root) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const diff = spawnSync("git", ["diff", "--stat"], { cwd: root, encoding: "utf8" });
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
    changed: status.status === 0 ? status.stdout.trim().split("\n").filter(Boolean).length : null,
    diffStat: diff.status === 0 ? diff.stdout.trim() : null,
  };
}

function commandDone() {
  const root = findRoot(process.cwd());
  const contract = requireContract(root);
  const checks = readJson(checksPath(root, contract.id), null);
  if (!checks) fail("REFUSED: no check evidence. Run: ratchet check");
  if (!checks.ok) fail("REFUSED: the last check run failed. Fix it, then run: ratchet check");

  const state = loadState(root, contract.id);
  const result = {
    version: 1,
    id: contract.id,
    goal: contract.goal,
    role: contract.role,
    verdict: "done",
    finishedAt: new Date().toISOString(),
    counts: { files: state.files.size, writes: state.writes },
    checks: {
      ok: checks.ok,
      ranAt: checks.ranAt,
      results: checks.results.map((r) => ({ id: r.id, status: r.status, durationMs: r.durationMs })),
    },
    git: gitFacts(root),
  };
  writeJson(path.join(runDir(root, contract.id), "result.json"), result);
  out(`DONE  ${contract.id}`);
  out(`files: ${result.counts.files}  writes: ${result.counts.writes}`);
  out(`checks: ${result.checks.results.map((r) => `${r.id}=${r.status === 0 ? "pass" : "fail"}`).join(" ")}`);
  out(`changed: ${result.git.changed ?? "?"} file(s)`);
}

function commandAudit(args) {
  const root = findRoot(process.cwd());
  const report = auditRules(root);
  if (args.has("json")) {
    out(JSON.stringify(report, null, 2));
    process.exit(report.errors.length ? 1 : 0);
  }
  if (report.missing) {
    out(`no rules file at ${report.file}`);
    out("add rows: rule<TAB>layer<TAB>enforcer<TAB>proof");
    process.exit(0);
  }
  out(`rules: ${report.rows.length}`);
  for (const row of report.rows) {
    out(`  ${row.layer.padEnd(7)} ${row.rule}  <- ${row.enforcer || "(none)"}`);
  }
  for (const w of report.warnings) out(`WARN  ${w}`);
  for (const e of report.errors) out(`FAIL  ${e}`);
  process.exit(report.errors.length ? 1 : 0);
}

function commandDoctor() {
  const root = findRoot(process.cwd());
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  add("git repo", fs.existsSync(path.join(root, ".git")), root);
  add(".ratchet/config.json", fs.existsSync(configPath(root)), configPath(root));
  const config = loadConfig(root);
  add("config version", config?.version === 1, String(config?.version ?? "missing"));
  add("checks configured", Boolean(config?.checks?.length), `${config?.checks?.length ?? 0}`);
  const contract = loadRun(root);
  add("active contract", Boolean(contract), contract?.id ?? "none");
  add("rules.tsv", fs.existsSync(path.join(stateDir(root), "rules.tsv")), path.join(stateDir(root), "rules.tsv"));
  add("opencode adapter", fs.existsSync(path.join(root, ".opencode/plugin/ratchet.js")), ".opencode/plugin/ratchet.js");
  for (const c of checks) out(`${c.ok ? "PASS" : "WARN"}  ${c.name}  ${c.detail}`);
  const hard = checks.slice(0, 4).filter((c) => !c.ok);
  process.exit(hard.length ? 1 : 0);
}

const MANAGED_START = "<!-- ratchet:begin -->";
const MANAGED_END = "<!-- ratchet:end -->";
const MANAGED = `${MANAGED_START}
## Ratchet workflow (managed)

Every non-trivial task starts with a contract and ends with evidence.

1. \`ratchet task start --role coder --goal "<goal>" --scope "<glob>"\`
2. Work. Writes outside the contract are denied by the adapter.
3. \`ratchet check\`
4. \`ratchet done\`

Rules are enforced in this order: architecture and types, lint and CI, tests, prose. Do not edit \`.ratchet/\`, bypass a hook with \`--no-verify\`, or widen scope silently.
${MANAGED_END}`;

function commandSync(args) {
  const root = findRoot(process.cwd());
  const file = path.join(root, "AGENTS.md");
  const current = readText(file, "");
  let next;
  if (current.includes(MANAGED_START) && current.includes(MANAGED_END)) {
    next = current.replace(new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}`), MANAGED);
  } else {
    next = (current.trimEnd() + "\n\n" + MANAGED + "\n").trimStart();
  }

  if (args.has("check")) {
    const ok = next === current;
    if (!ok) {
      out("DRIFT: AGENTS.md is not in sync with .ratchet. Run: ratchet sync");
      process.exit(1);
    }
    out("AGENTS.md is in sync");
    return;
  }

  writeText(file, next);
  out(`synced ${file}`);

  if (args.has("install")) {
    const adapter = path.join(import.meta.dirname, "..", "adapters", "opencode", "ratchet.js");
    const target = path.join(root, ".opencode/plugin/ratchet.js");
    ensureDir(path.dirname(target));
    fs.copyFileSync(adapter, target);
    out(`installed ${target}`);

    const hook = path.join(import.meta.dirname, "..", "adapters", "git", "pre-commit");
    const gitHook = path.join(root, ".git/hooks/pre-commit");
    if (fs.existsSync(path.join(root, ".git"))) {
      fs.copyFileSync(hook, gitHook);
      fs.chmodSync(gitHook, 0o755);
      out(`installed ${gitHook}`);
    }
  }
}

function commandInstall(args) {
  const skill = path.join(import.meta.dirname, "..", "skills", "ratchet-mode");
  const home = process.env.HOME || "";
  const targets = args.has("project")
    ? [
        path.join(process.cwd(), ".agents/skills/ratchet-mode"),
        path.join(process.cwd(), ".claude/skills/ratchet-mode"),
        path.join(process.cwd(), ".opencode/skills/ratchet-mode"),
      ]
    : [
        path.join(home, ".agents/skills/ratchet-mode"),
        path.join(home, ".pi/agent/skills/ratchet-mode"),
        path.join(home, ".claude/skills/ratchet-mode"),
      ];

  for (const target of targets) {
    ensureDir(path.dirname(target));
    if (fs.existsSync(target)) {
      out(`skip ${target} (exists)`);
      continue;
    }
    fs.symlinkSync(skill, target, "dir");
    out(`linked ${target}`);
  }
  out("skill installed. Add the always-on project block with: ratchet sync");
}

function commandPrompt(args) {
  const root = findRoot(process.cwd());
  const contract = requireContract(root);
  const state = loadState(root, contract.id);
  const brief = {
    run: contract.id,
    goal: contract.goal,
    role: contract.role,
    readOnly: contract.readOnly,
    writeScope: contract.scope,
    denied: contract.deny,
    budgets: contract.budgets,
    used: { files: state.files.size, writes: state.writes },
    verify: contract.verify.map((v) => v.cmd),
  };
  if (args.has("json")) {
    out(JSON.stringify(brief, null, 2));
    return;
  }
  out(`## Task contract ${contract.id}`);
  out(`Goal: ${contract.goal}`);
  out(`Role: ${contract.role}${contract.readOnly ? " (read-only)" : ""}`);
  out(`Write scope: ${contract.scope.join(", ") || "(none)"}`);
  out(`Denied: ${contract.deny.join(", ") || "(none)"}`);
  out(`Budgets: ${state.files.size}/${contract.budgets.maxFiles} files, ${state.writes}/${contract.budgets.maxWrites} writes`);
  out(`Verify: ${contract.verify.map((v) => v.cmd).join(" && ") || "(none)"}`);
  out("");
  out("Enforced by the guard, not by this prompt:");
  out("- Writes outside the scope are denied. Reads are allowed.");
  out("- `ratchet done` refuses without a passing `ratchet check`.");
  out("");
  out("If a write is blocked, finish within scope or start a new contract with a wider scope.");
}

function usage() {
  out(`ratchet - contract-enforced agent workflow

usage:
  ratchet init [--force]
  ratchet task start --role coder --goal "..." --scope "src/**" [--verify "npm test"]
  ratchet task status
  ratchet prompt [--json]                     # contract brief for the system prompt
  ratchet guard [--format claude|json]        # JSON event on stdin
  ratchet check [--timeout 120000]
  ratchet done
  ratchet audit [--json]
  ratchet doctor
  ratchet sync [--check] [--install]
  ratchet install [--project]                 # link the skill into harness skill dirs

layers: code > types > lint > CI > tests > prose. A rule that nothing enforces is a wish.`);
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const cmd = args.positional.shift();

if (args.has("version") || cmd === "version") {
  out("ratchet 0.1.0");
  process.exit(0);
}
if (args.has("help") || !cmd || cmd === "help") {
  usage();
  process.exit(0);
}

switch (cmd) {
  case "init":
    commandInit(args);
    break;
  case "task":
    commandTask(args);
    break;
  case "prompt":
    commandPrompt(args);
    break;
  case "guard":
    commandGuard(args);
    break;
  case "check":
    commandCheck(args);
    break;
  case "done":
    commandDone();
    break;
  case "audit":
    commandAudit(args);
    break;
  case "doctor":
    commandDoctor();
    break;
  case "sync":
    commandSync(args);
    break;
  case "install":
    commandInstall(args);
    break;
  default:
    usage();
    process.exit(1);
}
