// @ts-check
import path from "node:path";
import { allRuns, checksPath, contractSessions, currentId, eventsPath, isSessionBound, runDir, runFinished } from "./contract.mjs";
import { readJson, readJsonl } from "./fsx.mjs";
import { auditRules } from "./rules.mjs";

const DEFAULT_LIMIT = 30;

function reasonsOf(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => (entry && typeof entry.reason === "string" ? entry.reason.trim() : ""))
    .filter(Boolean);
}

function approvalsOf(value) {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({ rule: String(entry.rule ?? ""), reason: String(entry.reason ?? "").trim() }));
}

function oneLine(text, max = 140) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

/**
 * The global view: what the framework did across recent runs, what a worker
 * can fix, and what only a human can decide. It is a health report, not a test
 * log.
 *
 * `attention` stays the worker-fix queue for callers written against v1.
 * v2 adds `decisions` (human judgment) and `exceptions` (per-run evidence).
 * `options.ci` is one `{run, commit, status}` result for the current or latest
 * run; digest never asks the network by itself.
 */
export function buildDigest(root, options = {}) {
  const limit = Number(options.limit ?? DEFAULT_LIMIT);
  const thread = options.thread === undefined || options.thread === null ? "" : String(options.thread).trim();
  const all = allRuns(root);
  // `--thread` scopes the whole report: the rows, the counts, and the health
  // items. A lead should not be blamed for a sibling thread's run.
  const candidates = thread
    ? all.filter((contract) => contractSessions(contract).includes(thread))
    : all;
  const runs = candidates.slice(0, limit);
  const current = currentId(root);

  // A run without guard events is only a current problem if it started after
  // the adapter was first wired. Older blind runs are history: counting them
  // forever keeps the digest red and hides the runs that need attention now.
  const wiredSince =
    candidates
      .filter((contract) => readJsonl(eventsPath(root, contract.id)).length > 0)
      .map((contract) => contract.createdAt)
      .filter(Boolean)
      .sort()[0] ?? null;

  const rows = runs.map((contract) => {
    const result = readJson(path.join(runDir(root, contract.id), "result.json"), null);
    const checks = readJson(checksPath(root, contract.id), null);
    const events = readJsonl(eventsPath(root, contract.id));
    const audit = result?.scopeAudit ?? null;
    const finished = runFinished(root, contract.id);
    const historical =
      events.length === 0 &&
      Boolean(wiredSince) &&
      String(contract.createdAt ?? "") < String(wiredSince);
    const amendments = result?.amendments ?? contract.checkAmendments ?? [];
    const approvals = result?.approvals ?? contract.approvals ?? [];
    return {
      id: contract.id,
      goal: contract.goal,
      createdAt: contract.createdAt ?? null,
      session: contract.session_id ?? null,
      aliases: Array.isArray(contract.aliases) ? contract.aliases : [],
      verdict: result?.verdict ?? (finished ? "unknown" : "open"),
      checks: checks ? Boolean(checks.ok) : null,
      verify: (contract.verify ?? []).length,
      outside: audit?.outside?.length ?? null,
      outsidePaths: Array.isArray(audit?.outside) ? audit.outside.slice(0, 5) : [],
      amendments: amendments.length,
      amendmentReasons: reasonsOf(amendments),
      approvals: approvals.length,
      approvalEntries: approvalsOf(approvals),
      events: events.length,
      denies: events.filter((entry) => entry.decision === "deny").length,
      stranded: !finished && contract.id !== current && !isSessionBound(contract),
      historical,
    };
  });

  const count = (predicate) => rows.filter(predicate).length;
  const counts = {
    runs: rows.length,
    done: count((row) => row.verdict === "done"),
    abandoned: count((row) => row.verdict === "abandoned"),
    failed: count((row) => row.verdict === "failed"),
    open: count((row) => row.verdict === "open"),
    checksPass: count((row) => row.checks === true),
    checksFail: count((row) => row.checks === false),
    checksUnknown: count((row) => row.checks === null),
    outsideRuns: count((row) => (row.outside ?? 0) > 0),
    blind: count((row) => row.events === 0),
    historicalBlind: count((row) => row.events === 0 && row.historical),
    currentBlind: count((row) => row.events === 0 && !row.historical),
    wired: count((row) => row.events > 0),
    noVerify: count((row) => row.verify === 0),
    stranded: count((row) => row.stranded),
    events: rows.reduce((sum, row) => sum + row.events, 0),
    denies: rows.reduce((sum, row) => sum + row.denies, 0),
    amendments: rows.reduce((sum, row) => sum + row.amendments, 0),
    approvals: rows.reduce((sum, row) => sum + row.approvals, 0),
    ciPass: 0,
    ciFail: 0,
    ciUnknown: 0,
  };

  const rules = auditRules(root);
  // Worker fixes: things the next agent turn can repair without a judgment call.
  const attention = [];
  if (counts.currentBlind) {
    attention.push(`${counts.currentBlind} run(s) with no guard events (adapter not wired)`);
  }
  if (counts.stranded) attention.push(`${counts.stranded} stranded run(s) (close with ratchet abandon --run <id>)`);
  if (counts.open) attention.push(`${counts.open} open run(s) (finish with done or abandon)`);
  if (counts.noVerify) attention.push(`${counts.noVerify} run(s) with no verify command`);

  // Decisions: exceptions that a human has to accept, explain, or close.
  // Every entry names the command that moves it forward.
  const decisions = [];
  const exceptions = [];
  for (const row of rows) {
    for (const reason of row.amendmentReasons) {
      exceptions.push({ run: row.id, kind: "amendment", reason: oneLine(`amended checks: ${reason}`) });
      decisions.push({
        kind: "amendment",
        run: row.id,
        reason: oneLine(`check surface amended: ${reason}`),
        next: `ratchet evidence --run ${row.id}`,
      });
    }
    for (const approval of row.approvalEntries) {
      const detail = approval.reason ? `${approval.rule}: ${approval.reason}` : approval.rule;
      exceptions.push({ run: row.id, kind: "approval", reason: oneLine(`approved ${detail}`) });
      decisions.push({
        kind: "approval",
        run: row.id,
        reason: oneLine(`hard rule approved: ${detail}`),
        next: `ratchet evidence --run ${row.id}`,
      });
    }
    if ((row.outside ?? 0) > 0) {
      const sample = row.outsidePaths.length ? ` (${row.outsidePaths.join(", ")})` : "";
      exceptions.push({
        run: row.id,
        kind: "outside-scope",
        reason: oneLine(`${row.outside} changed path(s) outside scope${sample}`),
      });
      decisions.push({
        kind: "outside-scope",
        run: row.id,
        reason: oneLine(`${row.outside} changed path(s) outside scope${sample}`),
        next: `ratchet evidence --run ${row.id}`,
      });
    }
    if (row.checks === false) {
      exceptions.push({ run: row.id, kind: "checks-failed", reason: "checks failed" });
      decisions.push({
        kind: "checks-failed",
        run: row.id,
        reason: "checks failed",
        next: `ratchet evidence --run ${row.id}`,
      });
    }
  }

  const ci =
    options.ci && options.ci.status && typeof options.ci.status === "object" ? options.ci : null;
  if (ci) {
    const state = String(ci.status.state ?? "unknown");
    if (state === "pass") counts.ciPass = 1;
    else if (state === "fail") counts.ciFail = 1;
    else counts.ciUnknown = 1;
    if (state === "fail") {
      const workflow = ci.status.workflow ? ` (${ci.status.workflow})` : "";
      exceptions.push({ run: ci.run, kind: "ci-failed", reason: oneLine(`CI failed${workflow}`) });
      decisions.push({
        kind: "ci-failed",
        run: ci.run,
        reason: oneLine(`CI failed${workflow}`),
        next: `ratchet ci --run ${ci.run}`,
      });
    }
  }

  if (rules.configured && rules.errors.length) {
    decisions.push({
      kind: "rules",
      reason: `${rules.errors.length} rule(s) without an enforcer or proof`,
      next: "ratchet audit",
    });
  }

  return {
    version: 2,
    ...(thread ? { thread } : {}),
    total: rows.length,
    counts,
    history: { wiredSince, blind: counts.historicalBlind },
    rules: rules.missing
      ? { configured: false, total: 0, errors: 0, warnings: 0 }
      : { configured: true, total: rules.rows.length, errors: rules.errors.length, warnings: rules.warnings.length },
    attention,
    decisions,
    exceptions,
    ...(ci ? { ci } : {}),
    rows,
  };
}
