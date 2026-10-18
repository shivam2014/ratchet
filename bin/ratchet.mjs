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
import { syncAgents } from "../lib/agents-md.mjs";
import {
  ORDER,
  LABEL,
  detectHarnesses,
  installHarness,
  uninstallHarness,
  loadManifest,
  saveManifest,
} from "../lib/harnesses.mjs";
import readline from "node:readline/promises";

const BOOLEAN = new Set([
  "force", "read-only", "json", "check", "install", "all", "help", "version",
  "user", "project", "yes", "dry-run", "global",
]);


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
  out(`  ratchet install --project --harness pi,claude,opencode,t3`);
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

function disabledPath(root) {
  return path.join(stateDir(root), "disabled.json");
}

function disabledState(root) {
  const state = readJson(disabledPath(root), null);
  return state?.disabled ? state : null;
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
  const disabled = disabledState(root);
  const decision = disabled
    ? {
        allow: true,
        reason: `ratchet disabled: ${disabled.reason}`,
        paths: [],
        op: "other",
        runId: loadRun(root)?.id ?? null,
        disabled: true,
      }
    : decide(root, event);
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
  const add = (name, ok, detail = "", hard = false) => checks.push({ name, ok, detail, hard });
  add("git repo", fs.existsSync(path.join(root, ".git")), root, true);
  add(".ratchet/config.json", fs.existsSync(configPath(root)), configPath(root), true);
  const config = loadConfig(root);
  add("config version", config?.version === 1, String(config?.version ?? "missing"), true);
  add("checks configured", Boolean(config?.checks?.length), `${config?.checks?.length ?? 0}`, true);
  const contract = loadRun(root);
  add("active contract", Boolean(contract), contract?.id ?? "none");
  add("rules.tsv", fs.existsSync(path.join(stateDir(root), "rules.tsv")), path.join(stateDir(root), "rules.tsv"));
  const disabled = disabledState(root);
  add("ratchet enabled", !disabled, disabled ? `DISABLED: ${disabled.reason}` : "enabled");
  const manifest = loadManifest(root);
  for (const [name, record] of Object.entries(manifest.installed)) {
    const paths = record.paths ?? [];
    const ok = paths.length > 0 && paths.every((p) => fs.lstatSync(p, { throwIfNoEntry: false }));
    add(`${LABEL[name] ?? name} adapter`, ok, `${record.scope}: ${paths.join(", ")}`);
  }
  for (const c of checks) out(`${c.ok ? "PASS" : c.hard ? "FAIL" : "WARN"}  ${c.name}  ${c.detail}`);
  process.exit(checks.some((c) => c.hard && !c.ok) ? 1 : 0);
}

function installContext(root, args) {
  return {
    root,
    repoRoot: path.join(import.meta.dirname, ".."),
    home: process.env.HOME || "",
    scope: args.has("user") || args.has("global") ? "user" : "project",
    force: args.has("force"),
    dryRun: args.has("dry-run"),
    actions: [],
    warnings: [],
  };
}

function installGitHook(root, ctx) {
  if (!fs.existsSync(path.join(root, ".git"))) return;
  const src = path.join(ctx.repoRoot, "adapters", "git", "pre-commit");
  const dest = path.join(root, ".git", "hooks", "pre-commit");
  if (fs.existsSync(dest) && !readText(dest, "").includes("ratchet") && !ctx.force) {
    ctx.warnings.push(`git: ${dest} exists and is not ours; use --force to replace`);
    return;
  }
  const content = readText(src, "");
  if (fs.existsSync(dest) && readText(dest, "") === content) {
    ctx.actions.push(`unchanged ${dest}`);
    return;
  }
  ctx.actions.push(`${fs.existsSync(dest) ? "update" : "create"} ${dest}`);
  if (!ctx.dryRun) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }
}

async function selectHarnesses(args, detected) {
  const explicit = args
    .all("harness")
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;

  const available = ORDER.filter((h) => detected[h]);
  if (args.has("all") || args.has("yes") || !process.stdin.isTTY) return available;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(`Detected: ${available.join(", ") || "none"}\nInstall for [all/${ORDER.join(",")}] (all): `)
  ).trim();
  rl.close();
  if (!answer || answer === "all") return available;
  return answer.split(",").map((s) => s.trim()).filter(Boolean);
}

async function commandInstall(args) {
  const root = findRoot(process.cwd());
  if (!fs.existsSync(configPath(root))) fail("No .ratchet/config.json. Run: ratchet init");
  const detected = detectHarnesses();
  const names = [...new Set(await selectHarnesses(args, detected))];
  if (!names.length) fail(`No harness detected. Pass --harness ${ORDER.join("|")}.`);

  const ctx = installContext(root, args);
  const manifest = loadManifest(root);

  for (const name of names) {
    if (!ORDER.includes(name)) fail(`unknown harness: ${name}`);
    const paths = installHarness(name, ctx);
    manifest.installed[name] = { scope: ctx.scope, paths, at: new Date().toISOString() };
  }

  if (ctx.scope === "project") installGitHook(root, ctx);
  if (ctx.scope === "project") {
    const sync = syncAgents(root, { check: ctx.dryRun });
    ctx.actions.push(`${sync.changed ? "update" : "unchanged"} ${sync.file}`);
  }
  if (!ctx.dryRun) saveManifest(root, manifest);

  for (const action of ctx.actions) out(action);
  for (const warning of ctx.warnings) out(`WARN  ${warning}`);
  out(ctx.dryRun ? "dry run: nothing written" : `installed: ${names.join(", ")} (${ctx.scope})`);
}

function commandUninstall(args) {
  const root = findRoot(process.cwd());
  const manifest = loadManifest(root);
  const explicit = args
    .all("harness")
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const selected = explicit.length ? explicit : Object.keys(manifest.installed);
  if (!selected.length) {
    out("nothing installed");
    return;
  }

  const ctx = installContext(root, args);
  const protect = new Set(
    Object.entries(manifest.installed)
      .filter(([name]) => !selected.includes(name))
      .flatMap(([, record]) => record.paths ?? []),
  );
  for (const name of selected) {
    const record = manifest.installed[name];
    if (!record) {
      out(`skip ${name} (not installed)`);
      continue;
    }
    uninstallHarness(name, { ...ctx, scope: record.scope ?? ctx.scope }, record, protect);
    delete manifest.installed[name];
  }
  if (!ctx.dryRun) saveManifest(root, manifest);
  for (const action of ctx.actions) out(action);
  for (const warning of ctx.warnings) out(`WARN  ${warning}`);
  out(ctx.dryRun ? "dry run: nothing removed" : `uninstalled: ${selected.join(", ")}`);
}

function commandDisable(args) {
  const root = findRoot(process.cwd());
  if (!fs.existsSync(stateDir(root))) fail("No .ratchet directory. Run: ratchet init");
  const reason = String(args.one("reason", "no reason given"));
  writeJson(disabledPath(root), {
    disabled: true,
    reason,
    at: new Date().toISOString(),
    by: process.env.USER || null,
  });
  out(`ratchet DISABLED: ${reason}`);
  out("The guard will allow tool calls. Checks still run. Re-enable with: ratchet enable");
}

function commandEnable() {
  const root = findRoot(process.cwd());
  const file = disabledPath(root);
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
    out("ratchet enabled");
  } else {
    out("ratchet is already enabled");
  }
}

function commandStatus() {
  const root = findRoot(process.cwd());
  const contract = loadRun(root);
  const disabled = disabledState(root);
  const manifest = loadManifest(root);
  out(`ratchet: ${disabled ? "DISABLED" : "enabled"}`);
  if (disabled) out(`  since ${disabled.at}: ${disabled.reason}`);
  out(`contract: ${contract ? `${contract.id}  (${contract.goal})` : "none"}`);
  const entries = Object.entries(manifest.installed);
  if (!entries.length) {
    out("installed: none");
    return;
  }
  out("installed:");
  for (const [name, record] of entries) {
    out(`  ${name.padEnd(9)} ${record.scope.padEnd(8)} ${record.paths.join(", ")}`);
  }
}

function commandSync(args) {
  const root = findRoot(process.cwd());
  const result = syncAgents(root, { check: args.has("check") });
  if (args.has("check")) {
    if (result.changed) {
      out("DRIFT: AGENTS.md is not in sync with .ratchet. Run: ratchet sync");
      process.exit(1);
    }
    out("AGENTS.md is in sync");
    return;
  }
  out(`synced ${result.file}`);

  if (args.has("install")) {
    const ctx = installContext(root, args);
    installHarness("opencode", ctx);
    installGitHook(root, ctx);
    for (const action of ctx.actions) out(action);
    for (const warning of ctx.warnings) out(`WARN  ${warning}`);
  }
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

function commandReport(args) {
  const root = findRoot(process.cwd());
  const contract = requireContract(root);
  const events = readJsonl(eventsPath(root, contract.id));
  const checks = readJson(checksPath(root, contract.id), null);
  const summary = {
    id: contract.id,
    goal: contract.goal,
    allow: events.filter((e) => e.decision === "allow").length,
    deny: events.filter((e) => e.decision === "deny").length,
    unresolved: events.filter((e) => e.unresolved).length,
  };
  if (args.has("json")) {
    out(JSON.stringify({ summary, checks, events }, null, 2));
    return;
  }
  out(`run:     ${contract.id}`);
  out(`goal:    ${contract.goal}`);
  out(`events:  ${summary.allow} allow, ${summary.deny} deny${summary.unresolved ? `, ${summary.unresolved} unresolved` : ""}`);
  out(`checks:  ${checks ? `${checks.ok ? "pass" : "fail"} (${checks.ranAt})` : "not run"}`);
  out("");
  for (const e of events) {
    const paths = (e.paths ?? []).join(", ") || "-";
    const reason = e.reason ? `  — ${e.reason}` : "";
    out(`${e.decision.toUpperCase().padEnd(5)} ${String(e.tool).padEnd(6)} ${paths}${reason}`);
  }
}

function usage() {
  out(`ratchet - contract-enforced agent workflow

usage:
  ratchet init [--force]
  ratchet task start --role coder --goal "..." --scope "src/**" [--verify "npm test"]
  ratchet task status
  ratchet report [--json]                     # allow/deny trail for the current run
  ratchet prompt [--json]                     # contract brief for the system prompt
  ratchet guard [--format claude|json]        # JSON event on stdin
  ratchet check [--timeout 120000]
  ratchet done
  ratchet audit [--json]
  ratchet doctor
  ratchet sync [--check] [--install]
  ratchet install [--harness pi,claude,opencode,t3,codex] [--user|--project] [--all] [--dry-run] [--yes]
  ratchet uninstall [--harness ...] [--dry-run]
  ratchet status
  ratchet disable --reason "..."
  ratchet enable

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
  case "report":
    commandReport(args);
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
    await commandInstall(args);
    break;
  case "uninstall":
    commandUninstall(args);
    break;
  case "enable":
    commandEnable();
    break;
  case "disable":
    commandDisable(args);
    break;
  case "status":
    commandStatus();
    break;
  default:
    usage();
    process.exit(1);
}
