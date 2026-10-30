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
  addSessionAlias,
  allRuns,
  checksPath,
  clearCurrent,
  configPath,
  contractSessions,
  createContract,
  currentId,
  defaultConfig,
  detectChecks,
  eventsPath,
  isSessionBound,
  latestRun,
  liveRuns,
  loadConfig,
  loadRun,
  loadRunForSession,
  runDir,
  runFinished,
  saveConfig,
  saveContract,
} from "../lib/contract.mjs";
import { decide, loadState, record } from "../lib/decide.mjs";
import { runChecks, saveChecks } from "../lib/checks.mjs";
import { EventError, appendEvent, parseEvent } from "../lib/events.mjs";
import { evaluateStop } from "../lib/stop.mjs";
import { runPostChecks } from "../lib/post-checks.mjs";
import { computeCheckSurface, diffCheckSurface, lockCheckSurface } from "../lib/check-surface.mjs";
import { taskChanges, taskScopeViolations } from "../lib/scope-audit.mjs";
import { preCommitReport } from "../lib/precommit.mjs";
import { cleanViolation } from "../lib/clean.mjs";
import { buildEvidence, evidenceClean } from "../lib/evidence.mjs";
import { buildDigest } from "../lib/digest.mjs";
import { APPROVABLE_RULES } from "../lib/classify.mjs";
import { detectSandbox, quote as shellQuote, runSandboxed } from "../lib/sandbox.mjs";
import { routePrompt } from "../lib/route.mjs";
import { auditRules } from "../lib/rules.mjs";
import { syncAgents } from "../lib/agents-md.mjs";
import {
  ORDER,
  LABEL,
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  detectHarnesses,
  installHarness,
  uninstallHarness,
  loadManifest,
  saveManifest,
  which,
} from "../lib/harnesses.mjs";
import readline from "node:readline/promises";
import os from "node:os";
import { codexHome, findRatchetHooks, hookTrustHash, readTrustHash } from "../lib/codex-trust.mjs";

const BOOLEAN = new Set([
  "force", "read-only", "json", "check", "install", "all", "help", "version",
  "user", "project", "yes", "dry-run", "global", "pstack", "bend", "require-clean",
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
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
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

/** `--scope "src/**,tests/**"` is common input; accept it as two patterns. */
function splitGlobs(values) {
  return values
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function requireConfig(root) {
  const config = loadConfig(root);
  if (!config) fail(`No .ratchet/config.json at ${root}. Run: ratchet init`);
  return config;
}

/** A value flag such as `--session` or `--thread`. A bare flag is a usage error. */
function flagValue(args, key) {
  const value = args.one(key);
  if (value === undefined) return null;
  if (value === true) fail(`--${key} needs a value`);
  const text = String(value).trim();
  return text || null;
}

/**
 * Resolve the contract a CLI command acts on. A session sees its own contract
 * (lead session or worker alias) first, then the manual current pointer. The
 * pointer never lends a session-bound contract to a different session.
 */
function contractForSession(root, sessionId) {
  if (sessionId) return loadRunForSession(root, sessionId);
  const contract = loadRun(root);
  if (contract && runFinished(root, contract.id)) return null;
  return contract;
}

function requireContract(root, sessionId = null) {
  const contract = contractForSession(root, sessionId);
  if (!contract) {
    fail(
      sessionId
        ? `No active task contract for session ${sessionId}. Run: ratchet task start --session ${sessionId} --role coder --goal "..." --scope "src/**"`
        : "No active task contract. Run: ratchet task start --role coder --goal \"...\" --scope \"src/**\"",
    );
  }
  return contract;
}

function describeSession(contract) {
  const lead = leadSession(contract);
  const aliases = Array.isArray(contract.aliases) ? contract.aliases.filter(Boolean) : [];
  if (lead && aliases.length) return `${lead}  workers: ${aliases.join(", ")}`;
  if (lead) return lead;
  if (aliases.length) return `manual  workers: ${aliases.join(", ")}`;
  return "manual";
}

/** Abandon a live contract without claiming the work is done. */
function abandonLive(root, contract, reason) {
  const result = resultFor(root, contract, null, { verdict: "abandoned", reason });
  writeJson(path.join(runDir(root, contract.id), "result.json"), result);
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
  writeText(path.join(stateDir(root), ".gitignore"), "runs/\nlast-check.json\nevents.jsonl\ncurrent\ninstall.json\n");
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

/** The lead session on a contract. Empty for a manual contract. */
function leadSession(contract) {
  const lead = contract?.session_id;
  return lead === undefined || lead === null ? "" : String(lead).trim();
}

/**
 * Destructive commands act as the contract's lead. A worker alias inherits the
 * boundary for guard and check purposes, but it cannot close or amend the
 * lead's run: that would let a subagent end its parent's contract.
 */
function assertLeadOwner(contract, sessionId, command) {
  const lead = leadSession(contract);
  if (!sessionId || !lead || lead === sessionId) return;
  fail(
    [
      `session ${sessionId} is a worker alias of ${contract.id}; the lead session ${lead} owns it.`,
      `run: ratchet ${command} --session ${lead}`,
    ].join("\n"),
  );
}

function commandTaskBind(root, args, sessionId) {
  if (!sessionId) fail("task bind needs --session <child-id>");
  const runId = flagValue(args, "run");
  const leadArg = flagValue(args, "lead");
  let contract = null;
  if (runId) {
    contract = loadRun(root, runId);
    if (!contract) fail(`no run ${runId}`);
  } else if (leadArg) {
    const found = loadRunForSession(root, leadArg);
    contract = found && contractSessions(found).includes(leadArg) ? found : null;
    if (!contract) fail(`no contract is bound to lead session ${leadArg}`);
  } else {
    contract = loadRun(root);
    if (contract && runFinished(root, contract.id)) contract = null;
  }
  if (!contract) {
    fail("No active task contract to bind. Pass --run <id> or --lead <session-id>, or start one first.");
  }
  if (runFinished(root, contract.id)) fail(`run ${contract.id} is already closed`);
  if (contractSessions(contract).includes(sessionId)) {
    out(`already bound: ${sessionId} -> ${contract.id}`);
    return;
  }

  // A session belongs to one boundary. Moving it silently would let a worker
  // escape the lead's scope by re-binding, so refuse and name the owner.
  const owner = allRuns(root)
    .filter((other) => !runFinished(root, other.id) && other.id !== contract.id)
    .find((other) => contractSessions(other).includes(sessionId));
  if (owner) {
    fail(
      [
        `session ${sessionId} is already bound to ${owner.id} (${describeSession(owner)})`,
        `close that contract first: ratchet done --session ${leadSession(owner) || "<lead>"}`,
        `or close one run directly: ratchet abandon --run ${owner.id} --reason "..."`,
      ].join("\n"),
    );
  }

  addSessionAlias(contract, sessionId);
  // Binding is metadata on the contract, not a new current pointer: it must not
  // shift the CLI fallback away from the run a human is working on.
  saveContract(root, contract, { pointer: false });
  out(`BOUND  ${sessionId}`);
  out(`contract: ${contract.id}  (${contract.goal})`);
  out(`scope:    ${contract.scope.join(", ") || "(none)"}`);
  out("the worker inherits this contract's scope, budgets, checks, and evidence");
}

function commandTask(args) {
  const sub = args.positional[0];
  const root = findRoot(process.cwd());
  const config = requireConfig(root);
  const sessionId = flagValue(args, "session");

  if (sub === "status") {
    const contract = requireContract(root, sessionId);
    const state = loadState(root, contract.id);
    const checks = readJson(checksPath(root, contract.id), null);
    out(`run:     ${contract.id}`);
    out(`goal:    ${contract.goal}`);
    out(`role:    ${contract.role}${contract.readOnly ? " (read-only)" : ""}`);
    out(`session: ${describeSession(contract)}`);
    out(`scope:   ${contract.scope.join(", ") || "(none)"}`);
    out(`budgets: ${state.files.size}/${contract.budgets.maxFiles} files, ${state.writes}/${contract.budgets.maxWrites} writes`);
    out(`checks:  ${checks ? (checks.ok ? "pass" : "fail") + " (" + checks.ranAt + ")" : "not run"}`);
    return;
  }

  if (sub === "bind") {
    commandTaskBind(root, args, sessionId);
    return;
  }

  if (sub !== "start") {
    fail(
      'usage: ratchet task start [--session <id>] --role coder --goal "..." --scope "src/**"\n' +
        "       ratchet task status [--session <id>]\n" +
        "       ratchet task bind --session <child-id> [--run <id> | --lead <session-id>]",
    );
  }

  const requireClean = args.has("require-clean");
  if (requireClean) {
    const dirty = cleanViolation(root, { id: "a new contract", requireClean: true });
    if (dirty) fail(dirty);
  }

  // One live contract per checkout is the safe default. A session-bound start
  // may join other session-bound contracts, but a manual contract still keeps
  // the old single-contract rule: it has no session to own a second boundary.
  const live = liveRuns(root);
  const owned = sessionId
    ? live.filter((contract) => leadSession(contract) === sessionId)
    : live.filter((contract) => !isSessionBound(contract));
  const workerFor = sessionId
    ? live.filter(
        (contract) =>
          !owned.includes(contract) &&
          contractSessions(contract).includes(sessionId) &&
          leadSession(contract) !== sessionId,
      )
    : [];
  const blockers = live.filter(
    (contract) =>
      !owned.includes(contract) &&
      !workerFor.includes(contract) &&
      (sessionId ? !isSessionBound(contract) : true),
  );

  if (workerFor.length) {
    const first = workerFor[0];
    fail(
      [
        `session ${sessionId} is bound as a worker alias of ${first.id} (lead: ${leadSession(first) || "manual"})`,
        "a worker does not start a second contract; its lead owns the boundary",
        `finish it with: ratchet done --session ${leadSession(first) || "<lead>"}`,
        `or close it with: ratchet abandon --run ${first.id} --reason "..."`,
      ].join("\n"),
    );
  }

  if (blockers.length) {
    const first = blockers[0];
    fail(
      (sessionId
        ? [
            `a manual contract is still live: ${first.id}`,
            "a session cannot replace the human CLI's contract",
            "finish it with: ratchet done",
            'or close it with: ratchet abandon --reason "..."',
            `or attach this session to it: ratchet task bind --session ${sessionId} --run ${first.id}`,
          ]
        : [
            `${blockers.length} session-bound contract(s) are live: ${blockers.map((c) => c.id).join(", ")}`,
            "a manual contract would make this checkout multi-live without a session owner",
            "finish each with: ratchet done --session <id>",
            'or close one with: ratchet abandon --run <id> --reason "..."',
            "start a session contract instead: ratchet task start --session <id> ...",
            "one worktree per lead is still the safest split",
          ]
      ).join("\n"),
    );
  }

  // A contract the caller owns may be replaced on the record. This is how
  // --force keeps working without letting one session abandon another's run.
  if (owned.length) {
    if (!args.has("force")) {
      const first = owned[0];
      fail(
        [
          `a contract is still live: ${first.id}`,
          sessionId ? `finish it with: ratchet done --session ${sessionId}` : "finish it with: ratchet done",
          sessionId
            ? `or close it with: ratchet abandon --session ${sessionId} --reason "..."`
            : 'or close it with: ratchet abandon --reason "..."',
          "or replace it with: ratchet task start --force ... (records the old one as abandoned)",
        ].join("\n"),
      );
    }
    for (const contract of owned) {
      abandonLive(root, contract, "superseded by a new contract (task start --force)");
      out(`superseded: ${contract.id} (abandoned)`);
    }
  }

  const goal = String(args.one("goal", args.positional.slice(1).join(" ")) || "").trim();
  if (!goal) fail("task start needs --goal \"...\"");
  const role = String(args.one("role", "coder"));
  const readOnly = args.has("read-only") || role === "reviewer" || role === "scout";
  const scope = args.all("scope").length ? splitGlobs(args.all("scope")) : config.defaults?.scope ?? [];
  for (const value of args.all("scope")) {
    if (/\s/.test(String(value).trim()) && !String(value).includes(",")) {
      fail('--scope takes one glob per flag. Repeat --scope, or separate globs with commas: --scope "src/**,tests/**"');
    }
  }
  if (!readOnly && !scope.length) {
    fail('task start needs --scope (for example --scope "src/**" --scope "tests/**"), or pass --read-only.');
  }
  const deny = [...splitGlobs(config.defaults?.deny ?? []), ...splitGlobs(args.all("deny"))];
  const gates = [];
  if (args.has("pstack")) {
    gates.push(
      {
        artifact: ".ratchet/plan.md",
        before: ["src/**", "index.html", "styles.css"],
        message: "pstack /poteto-mode: write the chosen playbook and its steps to .ratchet/plan.md first",
      },
      {
        artifact: ".ratchet/sketch.md",
        before: ["src/**", "index.html", "styles.css"],
        message: "pstack /architect: sketch the types, signatures, and module shape in .ratchet/sketch.md first",
      },
    );
  }
  if (args.has("bend")) {
    gates.push({
      artifact: "LAWS.bend",
      before: ["**/*.bend"],
      message: "Bend: state the law in LAWS.bend before changing Bend code (the human owns the law; the agent owns the proof)",
    });
  }
  gates.push(...(config.gates ?? []));
  const scoped = gates.length
    ? [...new Set([...scope, ...gates.map((gate) => gate.artifact), ...(args.has("bend") ? ["PROOF.bend"] : [])])]
    : scope;
  const defaultVerify = [
    ...(config.checks ?? []).map((c) => c.cmd),
    ...(args.has("bend") ? [`${process.env.BEND_BIN || "bend"} PROOF.bend --check-only`] : []),
  ];
  const verify = args.all("verify").length ? args.all("verify") : defaultVerify;
  const contract = createContract(root, {
    goal,
    role,
    readOnly,
    requireClean,
    scope: scoped,
    deny,
    gates,
    maxFiles: Number(args.one("max-files", config.defaults?.maxFiles ?? 12)),
    maxWrites: Number(args.one("max-writes", config.defaults?.maxWrites ?? 60)),
    verify,
    checkSurface: lockCheckSurface(root, verify),
  });
  if (sessionId) contract.session_id = sessionId;
  saveContract(root, contract);
  out(`run:     ${contract.id}`);
  if (sessionId) out(`session: ${sessionId}`);
  out(`contract ${path.join(runDir(root, contract.id), "contract.json")}`);
  out(`scope:   ${contract.scope.join(", ")}`);
  out(`budgets: ${contract.budgets.maxFiles} files, ${contract.budgets.maxWrites} writes`);
  if (contract.gates?.length) out(`gates:   ${contract.gates.map((g) => g.artifact).join(", ")}`);
  if (contract.requireClean) out("clean:   required (tracked changes must be committed)");
  out(`verify:  ${contract.verify.map((v) => v.cmd).join(" && ") || "(none)"}`);
  const nowLive = liveRuns(root);
  if (nowLive.length > 1) {
    out("");
    out(`note:    ${nowLive.length} live contracts now share this checkout; the git index and working tree are still shared.`);
    out("         use one worktree per lead when file overlap is possible.");
  }
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

function guardFor(root, event) {
  const disabled = disabledState(root);
  return disabled
    ? {
        allow: true,
        reason: `ratchet disabled: ${disabled.reason}`,
        paths: [],
        op: "other",
        runId: loadRun(root)?.id ?? null,
        disabled: true,
      }
    : decide(root, event);
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
  const decision = guardFor(root, event);
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

function commandPreCommit(args) {
  const root = findRoot(process.cwd());
  const report = preCommitReport(root, {
    timeoutMs: Number(args.one("timeout", 120000)),
  });
  if (report.skipped) {
    out(`pre-commit: ${report.skipped}`);
    return;
  }
  out(`staged: ${report.staged.length} file(s)`);
  if (!report.contract) {
    out("WARN  no active contract: staged paths are not checked against scope");
  }
  if (report.guard?.length) {
    out("FAIL  guard state is staged:");
    for (const p of report.guard) out(`  ${p}`);
  }
  if (report.outside?.length) {
    out(
      `FAIL  ${report.outside.length} staged path(s) outside scope [${(report.contract?.scope ?? []).join(", ")}]:`,
    );
    for (const p of report.outside.slice(0, 20)) out(`  ${p}`);
  }
  if (report.error) out(`FAIL  ${report.error}`);

  if (report.checks) {
    for (const r of report.checks.results) {
      out(`${r.status === 0 ? "PASS" : "FAIL"}  ${r.id}  (${(r.durationMs / 1000).toFixed(1)}s)`);
      if (r.status !== 0) {
        if (r.failure) out(r.failure);
        else if (r.stdout) out(r.stdout.split("\n").slice(-20).join("\n"));
        if (r.stderr) out(r.stderr.split("\n").slice(-20).join("\n"));
      }
    }
    if (report.checks.empty) out("FAIL  no checks ran");
  }

  if (!report.ok) {
    out("");
    if (report.guard?.length) {
      out("Unstage runtime state: git restore --staged <path>");
    }
    if (report.outside?.length) {
      out("Stage only paths in the live contract, or start a contract that includes them.");
    }
    process.exit(1);
  }
  out("pre-commit: pass");
}

function commandHook(args) {
  if (args.positional[0] === "pre-commit") {
    commandPreCommit(args);
    return;
  }
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) fail("hook expects a JSON event on stdin");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("hook: stdin is not valid JSON");
  }
  let event;
  try {
    event = parseEvent(parsed);
  } catch (err) {
    if (err instanceof EventError) fail("hook: " + err.message, 2);
    throw err;
  }

  const root = findRoot(event.cwd);
  let decision;
  if (event.type === "prompt.submit") {
    const routed = routePrompt(root, event);
    decision = {
      context: routed.contract ? briefText(root, routed.contract) : null,
      run: routed.contract?.id ?? null,
      created: routed.created,
    };
    appendEvent(root, event, decision);
  } else if (event.type === "tool.before") {
    decision = guardFor(root, event);
    record(root, event, decision);
  } else if (event.type === "tool.after") {
    appendEvent(root, event, { continue: true, context: null });
    const post = runPostChecks(root, event, loadConfig(root));
    decision = { continue: true, context: post.context };
  } else {
    decision = evaluateStop(root, event);
    appendEvent(root, event, decision);
  }

  out(JSON.stringify(decision));
  if (decision.allow === false) {
    process.stderr.write(`[ratchet] ${decision.reason}\n`);
    process.exit(2);
  }
}

function commandCheck(args) {
  const root = findRoot(process.cwd());
  const config = requireConfig(root);
  const contract = contractForSession(root, flagValue(args, "session"));
  if (contract) {
    const dirty = cleanViolation(root, contract);
    if (dirty) fail(dirty);
  }
  if (contract?.checksLock) {
    const changes = diffCheckSurface(contract.checksLock, computeCheckSurface(root, contract.verify));
    if (changes.length) fail(`check surface changed: ${changes.join(", ")}. If the change is intended, run: ratchet amend --reason "..."`);
  }
  const checks = contract?.verify.length ? contract.verify : config.checks ?? [];
  if (!checks.length) fail("No checks configured. Add them to .ratchet/config.json or pass --verify at task start.");
  const report = runChecks(root, checks, { timeoutMs: Number(args.one("timeout", 120000)) });
  if (contract) saveChecks(root, contract.id, report);
  else writeJson(path.join(stateDir(root), "last-check.json"), report);
  for (const r of report.results) {
    out(`${r.status === 0 ? "PASS" : "FAIL"}  ${r.id}  (${(r.durationMs / 1000).toFixed(1)}s)`);
    if (r.status !== 0) {
      if (r.failure) {
        out(r.failure);
      } else if (r.stdout) {
        out(r.stdout.split("\n").slice(-20).join("\n"));
      }
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

function resultFor(root, contract, checks, extra = {}) {
  const state = loadState(root, contract.id);
  return {
    version: 1,
    id: contract.id,
    goal: contract.goal,
    role: contract.role,
    verdict: checks?.ok ? "done" : "failed",
    finishedAt: new Date().toISOString(),
    counts: { files: state.files.size, writes: state.writes },
    observed: { events: readJsonl(eventsPath(root, contract.id)).length, writes: state.writes },
    amendments: (contract.checkAmendments ?? []).map((a) => ({ at: a.at, reason: a.reason, changes: a.changes })),
    approvals: (contract.approvals ?? []).map((a) => ({ rule: a.rule, reason: a.reason, at: a.at })),
    checks: checks
      ? {
          ok: checks.ok,
          ranAt: checks.ranAt,
          empty: Boolean(checks.empty),
          results: checks.results.map((r) => ({ id: r.id, status: r.status, durationMs: r.durationMs })),
        }
      : null,
    git: gitFacts(root),
    ...extra,
  };
}

function commandDone(args) {
  const root = findRoot(process.cwd());
  const sessionId = flagValue(args, "session");
  const contract = requireContract(root, sessionId);
  assertLeadOwner(contract, sessionId, "done");
  const dirty = cleanViolation(root, contract);
  if (dirty) fail(dirty);
  if (contract.checksLock) {
    const changes = diffCheckSurface(contract.checksLock, computeCheckSurface(root, contract.verify));
    if (changes.length) {
      fail(
        `REFUSED: check surface changed: ${changes.join(", ")}. ` +
          'If the change is intended (new tests, a stronger check), run: ratchet amend --reason "..."',
      );
    }
  }
  const checks = readJson(checksPath(root, contract.id), null);
  if (!checks) fail("REFUSED: no check evidence. Run: ratchet check");
  if (!checks.ok) fail("REFUSED: the last check run failed. Fix it, then run: ratchet check");

  // Git is the authority for what changed. A shell write the classifier never
  // saw, or one hidden inside an interpreter, still has to land in scope.
  const changed = taskChanges(root, contract);
  const outside = taskScopeViolations(root, contract);
  if (outside.length) {
    fail(
      [
        `REFUSED: ${outside.length} changed path(s) outside scope [${(contract.scope ?? []).join(", ")}]:`,
        ...outside.slice(0, 20).map((p) => `  ${p}`),
        "Commit or revert them, or start a contract that includes them.",
      ].join("\n"),
    );
  }

  const result = resultFor(root, contract, checks, {
    verdict: "done",
    scopeAudit: { checkedAt: new Date().toISOString(), changed, outside },
  });
  const amendments = contract.checkAmendments ?? [];
  const approvals = contract.approvals ?? [];
  writeJson(path.join(runDir(root, contract.id), "result.json"), result);
  clearCurrent(root, contract.id);
  out(`DONE  ${contract.id}`);
  out(`files: ${result.counts.files}  writes: ${result.counts.writes}`);
  out(`checks: ${result.checks.results.map((r) => `${r.id}=${r.status === 0 ? "pass" : "fail"}`).join(" ")}`);
  if (amendments.length) out(`amended: ${amendments.map((a) => a.reason).join("; ")}`);
  if (approvals.length) out(`approved: ${approvals.map((a) => `${a.rule} (${a.reason})`).join("; ")}`);
  out(`changed: ${result.git.changed ?? "?"} file(s)`);
  if (!contract.readOnly && result.counts.writes === 0) {
    out("WARN  the guard observed 0 writes. Scope was not enforced for this run; only the check surface was.");
    out("      wire the harness: ratchet install --harness opencode --project");
  }
  const remaining = liveRuns(root);
  if (remaining.length) {
    out(`released: ${contract.id}; ${remaining.length} other live contract(s) remain: ${remaining.map((c) => c.id).join(", ")}`);
    out("         act on one with --session <id>, or run each lead in its own worktree.");
  } else {
    out("released: no active contract. Start the next task with ratchet task start.");
  }
}

/**
 * Re-baseline the locked check surface for the live contract, on the record.
 * Tests written inside a task legitimately change the check files; refusing
 * forever forces a second contract and strands the first. The amendment keeps
 * the audit trail honest: what moved, why, and when.
 */
function commandAmend(args) {
  const root = findRoot(process.cwd());
  const sessionId = flagValue(args, "session");
  const contract = requireContract(root, sessionId);
  assertLeadOwner(contract, sessionId, "amend");
  const reason = String(args.one("reason", "")).trim();
  if (!reason) fail('amend needs --reason "..." so the audit trail records why the check surface moved');
  if (!contract.checksLock) fail("this contract has no locked check surface to amend");

  const changes = diffCheckSurface(contract.checksLock, computeCheckSurface(root, contract.verify));
  if (!changes.length) {
    out("no check surface change: nothing to amend");
    return;
  }

  const amendment = {
    at: new Date().toISOString(),
    reason,
    changes,
    from: contract.checksLock.sha256 ?? null,
  };
  contract.checksLock = lockCheckSurface(root, contract.verify);
  amendment.to = contract.checksLock.sha256 ?? null;
  contract.checkAmendments = [...(contract.checkAmendments ?? []), amendment];
  saveContract(root, contract);

  out(`AMENDED  ${contract.id}`);
  for (const change of changes) out(`  ${change}`);
  out(`lock: ${contract.checkAmendments.length} amendment(s) recorded in the contract`);
}

/**
 * Close a contract without claiming the work is done. Without this the only
 * exits from a live contract are done or overwriting the pointer.
 */
function commandAbandon(args) {
  const root = findRoot(process.cwd());
  const requested = String(args.one("run", "")).trim();
  const sessionId = flagValue(args, "session");
  const contract = requested ? loadRun(root, requested) : requireContract(root, sessionId);
  if (!contract) fail(`no run ${requested}`);
  if (runFinished(root, contract.id)) fail(`run ${contract.id} is already closed`);
  if (!requested) assertLeadOwner(contract, sessionId, "abandon");
  const reason = String(args.one("reason", "")).trim();
  if (!reason) fail('abandon needs --reason "..." so the audit trail records why the contract was dropped');

  abandonLive(root, contract, reason);
  if (currentId(root) === contract.id) clearCurrent(root, contract.id);
  out(`ABANDONED  ${contract.id}`);
  out(`reason: ${reason}`);
  const remaining = liveRuns(root);
  if (remaining.length) {
    out(`still live: ${remaining.map((run) => run.id).join(", ")}`);
  } else {
    out("released: no active contract.");
  }
}

function commandApprove(args) {
  const root = findRoot(process.cwd());
  const sessionId = flagValue(args, "session");
  const contract = requireContract(root, sessionId);
  assertLeadOwner(contract, sessionId, "approve");
  const rule = String(args.one("rule", "")).trim();
  const reason = String(args.one("reason", "")).trim();
  if (!rule) fail(`approve needs --rule <${[...APPROVABLE_RULES].join("|")}>`);
  if (!APPROVABLE_RULES.has(rule)) fail(`rule ${rule} cannot be approved. Approvable: ${[...APPROVABLE_RULES].join(", ")}`);
  if (!reason) fail('approve needs --reason "..." so the audit trail records who approved it');
  const approvals = contract.approvals ?? [];
  if (approvals.some((entry) => entry.rule === rule)) fail(`rule ${rule} is already approved for ${contract.id}`);
  contract.approvals = [...approvals, { rule, reason, at: new Date().toISOString() }];
  saveContract(root, contract);
  out(`APPROVED  ${rule}`);
  out(`reason:    ${reason}`);
  out(`contract:  ${contract.id}`);
}

function contractForRun(root, args, command) {
  const config = requireConfig(root);
  // `run` creates a manual contract, so it keeps the single-contract rule.
  const live = liveRuns(root);
  if (live.length) {
    fail(
      [
        `${live.length} live contract(s) already own this checkout: ${live.map((c) => c.id).join(", ")}`,
        "finish each with: ratchet done --session <id>, or close one with: ratchet abandon --run <id> --reason \"...\"",
        "ratchet run starts a manual contract and cannot add a second boundary",
      ].join("\n"),
    );
  }
  const auto = config.auto ?? {};
  const goal = String(args.one("goal", command.join(" ")) || "run");
  const scope = args.all("scope").length
    ? splitGlobs(args.all("scope"))
    : Array.isArray(auto.scope)
      ? auto.scope
      : config.defaults?.scope ?? [];
  if (!scope.length) fail("run needs --scope, or auto.scope in .ratchet/config.json");
  const verify = args.all("verify").length
    ? args.all("verify")
    : (config.checks ?? []).map((check) => check.cmd);
  const requireClean = args.has("require-clean");
  if (requireClean) {
    const dirty = cleanViolation(root, { id: "a new run", requireClean: true });
    if (dirty) fail(dirty);
  }
  const contract = createContract(root, {
    goal,
    role: String(args.one("role", "coder")),
    requireClean,
    scope,
    deny: [...new Set([...splitGlobs(config.defaults?.deny ?? []), ...splitGlobs(auto.deny ?? [])])],
    gates: [...(config.gates ?? []), ...(auto.gates ?? [])],
    maxFiles: Number(args.one("max-files", auto.maxFiles ?? config.defaults?.maxFiles ?? 12)),
    maxWrites: Number(args.one("max-writes", auto.maxWrites ?? config.defaults?.maxWrites ?? 60)),
    verify,
    checkSurface: lockCheckSurface(root, verify),
  });
  saveContract(root, contract);
  return contract;
}

function commandRun(args) {
  const root = findRoot(process.cwd());
  const command = args.positional;
  if (!command.length) fail('run needs a command: ratchet run [flags] -- <command...>');

  const contract = contractForRun(root, args, command);
  const dir = runDir(root, contract.id);
  const briefFile = path.join(dir, "brief.md");
  writeText(briefFile, briefText(root, contract, { guarded: false }) + "\n");
  out(`run:     ${contract.id}`);
  out(`brief:   ${briefFile}`);
  out(`verify:  ${contract.verify.map((v) => v.cmd).join(" && ") || "(none)"}`);

  const started = Date.now();
  const child = spawnSync(command[0], command.slice(1), {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      RATCHET: "1",
      RATCHET_RUN: contract.id,
      RATCHET_BRIEF: briefFile,
      RATCHET_CONTRACT: path.join(dir, "contract.json"),
    },
  });
  const commandStatus = child.status ?? 1;
  if (child.error) out(`command: fail (${child.error.message})`);

  const checks = runChecks(root, contract.verify, { timeoutMs: Number(args.one("timeout", 120000)) });
  saveChecks(root, contract.id, checks);
  const verdict = checks.empty ? "uncertified" : checks.ok ? "done" : "failed";
  const result = resultFor(root, contract, checks, {
    verdict,
    guard: "post-hoc",
    counts: { files: null, writes: null },
    command: command.join(" "),
    commandStatus,
    durationMs: Date.now() - started,
  });
  writeJson(path.join(dir, "result.json"), result);

  out(`command: ${commandStatus === 0 ? "pass" : `fail (${commandStatus})`}`);
  out(`checks:  ${checks.empty ? "none" : checks.ok ? "pass" : "fail"}`);
  out(`verdict: ${verdict}`);
  out(`result:  ${path.join(dir, "result.json")}`);
  process.exit(commandStatus === 0 && checks.ok ? 0 : 1);
}

/**
 * Run one command under the live contract's kernel write fence. This is the
 * manual door to the same profile the OpenCode adapter applies to bash calls:
 * useful for a one-off probe, a harness that cannot rewrite tool input, and the
 * test suite. It always fences; use `ratchet check` for the control plane.
 */
function commandSandbox(args) {
  const root = findRoot(process.cwd());
  const contract = requireContract(root);
  const command = args.positional;
  if (!command.length) fail("usage: ratchet sandbox -- <command...>");
  const detected = detectSandbox();
  if (!detected.backend) fail(`sandbox unavailable: ${detected.reason}`);

  const line = command.map((part) => shellQuote(part)).join(" ");
  const result = runSandboxed(line, {
    root,
    contract,
    cwd: process.cwd(),
    timeoutMs: Number(args.one("timeout", 0)) || undefined,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status);
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

function adapterNoops(adapterPath, event) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-doctor-"));
  try {
    const result = spawnSync(process.execPath, [adapterPath], {
      input: JSON.stringify({ ...event, cwd: tmp }),
      encoding: "utf8",
      cwd: tmp,
    });
    return { ok: result.status === 0 && result.stdout.trim() === "", detail: (result.stderr || result.stdout || "").trim() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function harnessChecks(repoRoot, requested, root) {
  const checks = [];
  const add = (name, ok, detail, hard = true) => checks.push({ name, ok, detail, hard });
  const home = process.env.HOME || "";

  if (requested.includes("codex")) {
    const dir = codexHome(home);
    const userHooks = path.join(dir, "hooks.json");
    const projectHooks = path.join(root, ".codex", "hooks.json");
    const hooksFile = findRatchetHooks(projectHooks).length ? projectHooks : userHooks;
    const found = findRatchetHooks(hooksFile);
    const expected = `${process.execPath} ${path.join(repoRoot, "adapters", "codex", "hook.mjs")}`;
    for (const spec of CODEX_HOOK_EVENTS) {
      const handlers = found.filter((hook) => hook.event === spec.event);
      add(
        `codex ${spec.event} hook`,
        handlers.length === 1,
        handlers.length ? hooksFile : `${handlers.length} handlers in ${hooksFile}`,
      );
      for (const hook of handlers) {
        add(`codex ${spec.event} command exact`, hook.handler.command === expected, hook.handler.command);
        const computed = hookTrustHash(hook.group, hook.handler, spec.event);
        const recorded = readTrustHash(dir, hook.key);
        add(
          `codex ${spec.event} trust hash`,
          recorded === computed,
          recorded ? `recorded ${recorded.slice(0, 20)}…` : "missing",
        );
      }
    }
    for (const payload of [
      { hook_event_name: "UserPromptSubmit", prompt: "doctor" },
      {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: x.txt\n+hi\n*** End Patch" },
      },
      {
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: x.txt\n+hi\n*** End Patch" },
        tool_response: { success: true },
      },
      { hook_event_name: "Stop" },
    ]) {
      const noop = adapterNoops(path.join(repoRoot, "adapters", "codex", "hook.mjs"), {
        session_id: "doctor",
        ...payload,
      });
      add(`codex ${payload.hook_event_name} no-op`, noop.ok, noop.detail || "silent outside a contract");
    }
  }

  if (requested.includes("claude")) {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
    const settingsFile = path.join(dir, "settings.json");
    const settings = readJson(settingsFile, null);
    const expected = `${process.execPath} ${path.join(repoRoot, "adapters", "claude", "hook.mjs")}`;
    for (const spec of CLAUDE_HOOK_EVENTS) {
      const list = Array.isArray(settings?.hooks?.[spec.event]) ? settings.hooks[spec.event] : [];
      const handler = list
        .filter((entry) => Array.isArray(entry?.hooks))
        .flatMap((entry) => entry.hooks)
        .find((h) => typeof h?.command === "string" && h.command.includes("ratchet"));
      add(`claude ${spec.event} hook`, Boolean(handler), settingsFile);
      if (handler) add(`claude ${spec.event} command exact`, handler.command === expected, handler.command);
    }
    for (const event of [
      { hook_event_name: "UserPromptSubmit", prompt: "doctor" },
      { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x.txt" } },
      { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "x.txt" }, tool_response: {} },
      { hook_event_name: "Stop" },
    ]) {
      const noop = adapterNoops(path.join(repoRoot, "adapters", "claude", "hook.mjs"), {
        session_id: "doctor",
        ...event,
      });
      add(`claude ${event.hook_event_name} no-op`, noop.ok, noop.detail || "silent outside a contract");
    }
  }

  return checks;
}

function commandDoctor(args) {
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
  const sandbox = detectSandbox();
  add(
    "sandbox",
    Boolean(sandbox.backend),
    sandbox.backend ? `${sandbox.backend} (${sandbox.bin})` : sandbox.reason,
    Boolean(config?.sandbox?.required && !sandbox.backend),
  );
  // An installed adapter copy is what actually applies the rewrite. A
  // pre-sandbox copy silently ignores the command, so name it instead of
  // claiming enforcement.
  if (config?.sandbox?.enabled) {
    const adapters = (detectAdapters(root).get("opencode") ?? []).map((item) => item.path);
    const rewrite = adapters.some((file) => readText(file, "").includes("sandbox"));
    add(
      "sandbox adapter rewrite",
      rewrite,
      adapters.length
        ? rewrite
          ? adapters.join(", ")
          : `installed adapter predates the sandbox: ${adapters.join(", ")}; reinstall it`
        : "no OpenCode adapter found",
      Boolean(config.sandbox.required && !rewrite),
    );
  }
  add("rules.tsv", fs.existsSync(path.join(stateDir(root), "rules.tsv")), path.join(stateDir(root), "rules.tsv"));
  const disabled = disabledState(root);
  add("ratchet enabled", !disabled, disabled ? `DISABLED: ${disabled.reason}` : "enabled");
  const manifest = loadManifest(root);
  for (const [name, record] of Object.entries(manifest.installed)) {
    const paths = record.paths ?? [];
    const ok = paths.length > 0 && paths.every((p) => fs.lstatSync(p, { throwIfNoEntry: false }));
    add(`${LABEL[name] ?? name} adapter`, ok, `${record.scope}: ${paths.join(", ")}`);
  }
  const requested = args
    .all("harness")
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.includes("all")) requested.push("codex", "claude");
  if (requested.length) checks.push(...harnessChecks(path.join(import.meta.dirname, ".."), requested, root));
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

function linkCli(ctx) {
  const binDir = path.join(ctx.home, ".local", "bin");
  const link = path.join(binDir, "ratchet");
  const cli = path.join(ctx.repoRoot, "bin", "ratchet.mjs");
  if (fs.existsSync(link)) {
    if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === cli) {
      ctx.actions.push(`unchanged ${link}`);
    } else {
      ctx.warnings.push(`${link} exists and is not the Ratchet CLI; add ${binDir} to PATH or set RATCHET_BIN`);
    }
    return;
  }
  ensureDir(binDir);
  if (!ctx.dryRun) fs.symlinkSync(cli, link);
  ctx.actions.push(`link ${link}`);
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
  if (ctx.scope === "user") linkCli(ctx);
  if (ctx.scope === "project" && !which("ratchet")) {
    ctx.warnings.push("ratchet is not on PATH; run `ratchet install --harness <name> --user` to link ~/.local/bin/ratchet, or set RATCHET_BIN");
  }
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

/** Adapter files that exist on disk even when no manifest in this repo records them. */
function detectAdapters(root) {
  const home = process.env.HOME || "";
  const found = new Map();
  const add = (name, file, scope) => {
    if (!file || !fs.existsSync(file)) return;
    const list = found.get(name) ?? [];
    if (!list.some((item) => item.path === file)) list.push({ path: file, scope });
    found.set(name, list);
  };

  add("opencode", path.join(home, ".config", "opencode", "plugins", "ratchet.js"), "user");
  add("opencode", path.join(root, ".opencode", "plugins", "ratchet.js"), "project");
  for (const [name, file] of [
    ["claude", path.join(home, ".claude", "settings.json")],
    ["codex", path.join(home, ".codex", "hooks.json")],
  ]) {
    if (fs.existsSync(file) && readText(file, "").includes("ratchet")) add(name, file, "user");
  }
  for (const [name, dir] of [
    ["pi", path.join(home, ".pi", "agent", "extensions")],
    ["pi", path.join(root, ".pi", "extensions")],
  ]) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().includes("ratchet")) continue;
      const scope = path.resolve(dir).startsWith(path.resolve(root)) ? "project" : "user";
      add(name, path.join(dir, entry), scope);
    }
  }
  return found;
}

function formatAge(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

function commandStatus(args) {
  const root = findRoot(process.cwd());
  const sessionId = flagValue(args, "session");
  const contract = contractForSession(root, sessionId);
  const live = liveRuns(root);
  const disabled = disabledState(root);
  const manifest = loadManifest(root);
  out(`ratchet: ${disabled ? "DISABLED" : "enabled"}`);
  if (disabled) out(`  since ${disabled.at}: ${disabled.reason}`);
  out(`contract: ${contract ? `${contract.id}  (${contract.goal})` : "none"}${sessionId && !contract ? `  (session ${sessionId})` : ""}`);
  if (contract) {
    out(`started: ${contract.createdAt}  (${formatAge(contract.createdAt)})`);
    out(`session: ${describeSession(contract)}`);
  }
  // The one-contract rule was repo-scoped. Multi-session mode is a bridge,
  // not a merge: git still has one index and one working tree per checkout.
  if (live.length > 1 || (live.length === 1 && live[0].id !== contract?.id)) {
    out(`live: ${live.length} contract(s) in this checkout`);
    for (const run of live) {
      out(`  ${run.id}  session: ${describeSession(run)}  ${run.goal}  (${formatAge(run.createdAt)})`);
    }
  }
  if (live.length > 1) {
    out("WARN  more than one live contract shares this checkout. The git index and working tree are shared, so file conflicts are still possible. Use one worktree per lead.");
  }
  const liveIds = new Set(live.map((run) => run.id));
  const stranded = allRuns(root).filter((run) => !runFinished(root, run.id) && !liveIds.has(run.id));
  if (stranded.length) {
    out(`stranded: ${stranded.length} open run(s) with no pointer  (close with ratchet abandon --run <id> --reason "...")`);
  }
  const sandbox = detectSandbox();
  out(`sandbox: ${sandbox.backend ? `${sandbox.backend} (write fence available)` : `none (${sandbox.reason})`}`);
  const entries = Object.entries(manifest.installed);
  const listed = new Set(entries.flatMap(([, record]) => record.paths ?? []));
  const detected = detectAdapters(root);
  if (!entries.length && !detected.size) {
    out("installed: none");
    return;
  }
  out("installed:");
  for (const [name, record] of entries) {
    out(`  ${name.padEnd(9)} ${record.scope.padEnd(8)} ${record.paths.join(", ")}`);
  }
  // User-level adapters installed before a manifest existed (or from another
  // repo) still guard this project. Report them instead of "installed: none".
  for (const [name, list] of detected) {
    for (const item of list) {
      if (listed.has(item.path)) continue;
      out(`  ${name.padEnd(9)} ${item.scope.padEnd(8)} ${item.path}  (detected)`);
    }
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

function oneLine(text, max = 160) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

function briefText(root, contract, { guarded = true } = {}) {
  const state = loadState(root, contract.id);
  const lines = [
    `## Task contract ${contract.id}`,
    `Goal: ${contract.goal}`,
    `Role: ${contract.role}${contract.readOnly ? " (read-only)" : ""}`,
  ];
  if (contract.profile) {
    lines.push(`Profile: ${contract.profile}`);
    const skills = Array.isArray(contract.skills) ? contract.skills : [];
    if (!skills.length) {
      lines.push("Likely skills: none");
    } else {
      lines.push("Likely skills:");
      for (const skill of skills) {
        const where = skill.path || "(not installed)";
        const description = oneLine(skill.description);
        lines.push(`- ${skill.name}  ${where}${description ? `  ${description}` : ""}`);
      }
      lines.push("Read these skill files before coding. If none apply, say so.");
    }
  }
  lines.push(
    `Write scope: ${contract.scope.join(", ") || "(none)"}`,
    `Denied: ${contract.deny.join(", ") || "(none)"}`,
    `Budgets: ${state.files.size}/${contract.budgets.maxFiles} files, ${state.writes}/${contract.budgets.maxWrites} writes`,
    `Verify: ${contract.verify.map((v) => v.cmd).join(" && ") || "(none)"}`,
    "",
  );
  if (guarded) {
    lines.push(
      "Enforced by the guard, not by this prompt:",
      "- Writes outside the scope are denied. Reads are allowed.",
      "- `ratchet done` refuses without a passing `ratchet check`.",
      "",
      "If a write is blocked, finish within scope or start a new contract with a wider scope.",
    );
  } else {
    lines.push(
      "Enforced after the run, not during it:",
      "- The wrapper runs the verify commands when the command exits.",
      "- It cannot deny a tool call. The git hook and CI remain the authority.",
      "",
      "Keep the work inside the scope. The checks at the end decide whether it passed.",
    );
  }
  return lines.join("\n");
}

function commandPrompt(args) {
  const root = findRoot(process.cwd());
  const contract = requireContract(root, flagValue(args, "session"));
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
    ...(contract.profile ? { profile: contract.profile } : {}),
    ...(Array.isArray(contract.skills) && contract.skills.length ? { skills: contract.skills } : {}),
  };
  if (args.has("json")) {
    out(JSON.stringify(brief, null, 2));
    return;
  }
  out(briefText(root, contract));
}

function commandReport(args) {
  const root = findRoot(process.cwd());
  // After done the pointer is released, so fall back to the newest run.
  const contract = contractForSession(root, flagValue(args, "session")) ?? latestRun(root);
  if (!contract) fail("No run found. Start one with: ratchet task start --role coder --goal \"...\" --scope \"src/**\"");
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

  // Decisions made while no contract was live have no run to attach to.
  const unbound = readJsonl(path.join(stateDir(root), "events.jsonl"));
  if (unbound.length) {
    out("");
    out(`unbound: ${unbound.length} decision(s) outside a contract`);
    for (const e of unbound.slice(-20)) {
      const paths = (e.paths ?? []).join(", ") || "-";
      const reason = e.reason ? `  — ${e.reason}` : "";
      out(`${String(e.decision).toUpperCase().padEnd(5)} ${String(e.tool).padEnd(6)} ${paths}${reason}`);
    }
  }

  const outside = taskScopeViolations(root, contract);
  if (outside.length) {
    out("");
    out(`outside scope: ${outside.length} changed path(s)`);
    for (const p of outside.slice(0, 20)) out(`  ${p}`);
  }
}

function commandEvidence(args) {
  const root = findRoot(process.cwd());
  const id = String(args.one("run", "")).trim();
  const contract = id
    ? loadRun(root, id)
    : contractForSession(root, flagValue(args, "session")) ?? latestRun(root);
  if (!contract) fail("No run found. Start one with: ratchet task start --role coder --goal \"...\" --scope \"src/**\"");
  const evidence = buildEvidence(root, contract);
  const clean = evidenceClean(evidence);
  if (args.has("json")) {
    out(JSON.stringify({ ...evidence, clean }, null, 2));
    process.exit(clean ? 0 : 1);
  }

  out(`EVIDENCE  ${evidence.run}`);
  out(`goal:       ${evidence.goal}`);
  out(`verdict:    ${evidence.verdict}${clean ? "" : "  (not clean)"}`);
  out(`started:    ${evidence.startedAt}`);
  if (evidence.finishedAt) out(`finished:   ${evidence.finishedAt}`);
  out(`scope:      ${evidence.contract.scope.join(", ") || "(none)"}`);
  out(`verify:     ${evidence.contract.verify.join(" && ") || "(none)"}`);
  if (evidence.checks) {
    const passed = evidence.checks.results.filter((entry) => entry.status === 0).length;
    out(`checks:     ${passed}/${evidence.checks.results.length} pass  (${evidence.checks.ranAt})`);
    for (const entry of evidence.checks.results) {
      out(`  ${entry.status === 0 ? "PASS" : "FAIL"}  ${entry.id}  ${entry.cmd}`);
    }
  } else {
    out("checks:     none recorded");
  }
  out(`changes:    ${evidence.changes.count} file(s), ${evidence.changes.outsideCount} outside scope`);
  for (const p of evidence.changes.changed.slice(0, 20)) {
    out(`  ${evidence.changes.outside.includes(p) ? "OUT " : "    "}${p}`);
  }
  out(`guard:      ${evidence.guard.events} event(s), ${evidence.guard.writes ?? "?"} write(s)`);
  out(`exceptions: ${evidence.exceptions.amendments.length} amendment(s), ${evidence.exceptions.approvals.length} approval(s)`);
  out(`rules:      ${evidence.rules.configured ? `${evidence.rules.total} rule(s), ${evidence.rules.errors} error(s)` : "not configured"}`);
  out("ci:         not recorded; git and CI remain the authority");
  if (!clean) out("NOTE: this run is not clean; do not present it as done.");
  process.exit(clean ? 0 : 1);
}

function commandDigest(args) {
  const root = findRoot(process.cwd());
  const thread = flagValue(args, "thread");
  const digest = buildDigest(root, { limit: Number(args.one("limit", 30)), thread });
  if (!digest.total) {
    fail(
      thread
        ? `No runs for thread ${thread}. Start one with: ratchet task start --session ${thread} --role coder --goal "..." --scope "src/**"`
        : "No runs found. Start one with: ratchet task start --role coder --goal \"...\" --scope \"src/**\"",
    );
  }
  const healthy = digest.attention.length === 0;
  if (args.has("json")) {
    out(JSON.stringify({ ...digest, healthy }, null, 2));
    process.exit(healthy ? 0 : 1);
  }

  const c = digest.counts;
  out(`RATCHET DIGEST  last ${digest.total} run(s)${thread ? ` for thread ${thread}` : ""}`);
  out(`runs:       ${c.done} done · ${c.abandoned} abandoned · ${c.failed} failed · ${c.open} open`);
  out(`checks:     ${c.checksPass} pass · ${c.checksFail} fail · ${c.checksUnknown} unknown`);
  out(`scope:      ${c.outsideRuns} run(s) with outside changes`);
  out(`guard:      ${c.wired}/${c.runs} wired · ${c.events} events · ${c.denies} deny`);
  if (digest.history?.blind) {
    out(`history:    ${digest.history.blind} run(s) before guard wiring (not counted)`);
  }
  out(`exceptions: ${c.amendments} amendment(s) · ${c.approvals} approval(s)`);
  out(`rules:      ${digest.rules.configured ? `${digest.rules.total} rule(s) · ${digest.rules.errors} error(s)` : "not configured"}`);
  if (healthy) {
    out("health:     no attention items");
  } else {
    out("needs attention:");
    for (const item of digest.attention) out(`  - ${item}`);
  }
  process.exit(healthy ? 0 : 1);
}

function usage() {
  out(`ratchet - contract-enforced agent workflow

usage:
  ratchet init [--force]
  ratchet task start [--session <id>] --role coder --goal "..." --scope "src/**" [--scope "tests/**"] [--max-files N] [--max-writes N] [--verify "npm test"] [--require-clean] [--pstack] [--bend] [--force]
  ratchet task status [--session <id>]
  ratchet task bind --session <child-id> [--run <id> | --lead <session-id>]
  ratchet report [--session <id>] [--json]    # allow/deny trail for the current run
  ratchet evidence [--run <id> | --session <id>] [--json]  # the run certificate: checks, changes, exceptions
  ratchet digest [--limit N] [--thread <id>] [--json]  # global view, optionally one thread's runs
  ratchet prompt [--session <id>] [--json]    # contract brief for the system prompt
  ratchet guard [--format claude|json]        # JSON event on stdin
  ratchet hook                                # normalized lifecycle event on stdin
  ratchet hook pre-commit                     # staged paths vs contract scope, then verify
  ratchet run [--goal "..."] [--scope "src/**"] [--verify "npm test"] [--require-clean] -- <command...>
  ratchet sandbox -- <command...>             # run under the live contract's write fence
  ratchet check [--timeout 120000]
  ratchet done
  ratchet amend --reason "..."                # re-baseline the locked check surface, on the record
  ratchet abandon --reason "..." [--run <id>]  # close the live contract, or one stranded run
  ratchet approve --rule force-push --reason "..."  # allow one operational hard rule, on the record
  ratchet audit [--json]
  ratchet doctor [--harness codex,claude|all]
  ratchet sync [--check] [--install]
  ratchet install [--harness pi,claude,opencode,t3,codex] [--user|--project] [--all] [--dry-run] [--yes]
  ratchet uninstall [--harness ...] [--dry-run]
  ratchet status [--session <id>]
  ratchet disable --reason "..."
  ratchet enable

sessions: a contract is a thread boundary. --session binds it to one harness
session; task bind attaches a worker session to the lead's contract. --force
replaces the caller's own contract, never another session's. More than one
session contract may share a checkout, but git still has one index per
checkout: use one worktree per lead when file overlap is possible.

layers: code > types > lint > CI > tests > prose. A rule that nothing enforces is a wish.`);
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const cmd = args.positional.shift();

if (args.has("version") || cmd === "version") {
  const pkg = readJson(path.join(import.meta.dirname, "..", "package.json"), {});
  out(`ratchet ${pkg.version ?? "0.0.0"}`);
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
  case "evidence":
    commandEvidence(args);
    break;
  case "digest":
    commandDigest(args);
    break;
  case "guard":
    commandGuard(args);
    break;
  case "hook":
    commandHook(args);
    break;
  case "run":
    commandRun(args);
    break;
  case "sandbox":
    commandSandbox(args);
    break;
  case "check":
    commandCheck(args);
    break;
  case "done":
    commandDone(args);
    break;
  case "amend":
    commandAmend(args);
    break;
  case "abandon":
    commandAbandon(args);
    break;
  case "approve":
    commandApprove(args);
    break;
  case "audit":
    commandAudit(args);
    break;
  case "doctor":
    commandDoctor(args);
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
    commandStatus(args);
    break;
  default:
    usage();
    process.exit(1);
}
