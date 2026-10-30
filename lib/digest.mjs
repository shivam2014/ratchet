// @ts-check
import path from "node:path";
import { allRuns, checksPath, currentId, eventsPath, runDir, runFinished } from "./contract.mjs";
import { readJson, readJsonl } from "./fsx.mjs";
import { auditRules } from "./rules.mjs";

const DEFAULT_LIMIT = 30;

/**
 * The global view: what the framework did across recent runs, and what needs a
 * human. This is not a test log; it is a health report.
 */
export function buildDigest(root, options = {}) {
  const limit = Number(options.limit ?? DEFAULT_LIMIT);
  const runs = allRuns(root).slice(0, limit);
  const current = currentId(root);

  const rows = runs.map((contract) => {
    const result = readJson(path.join(runDir(root, contract.id), "result.json"), null);
    const checks = readJson(checksPath(root, contract.id), null);
    const events = readJsonl(eventsPath(root, contract.id));
    const audit = result?.scopeAudit ?? null;
    const finished = runFinished(root, contract.id);
    return {
      id: contract.id,
      goal: contract.goal,
      verdict: result?.verdict ?? (finished ? "unknown" : "open"),
      checks: checks ? Boolean(checks.ok) : null,
      verify: (contract.verify ?? []).length,
      outside: audit?.outside?.length ?? null,
      amendments: result?.amendments?.length ?? contract.checkAmendments?.length ?? 0,
      approvals: result?.approvals?.length ?? contract.approvals?.length ?? 0,
      events: events.length,
      denies: events.filter((entry) => entry.decision === "deny").length,
      stranded: !finished && contract.id !== current,
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
    wired: count((row) => row.events > 0),
    noVerify: count((row) => row.verify === 0),
    stranded: count((row) => row.stranded),
    events: rows.reduce((sum, row) => sum + row.events, 0),
    denies: rows.reduce((sum, row) => sum + row.denies, 0),
    amendments: rows.reduce((sum, row) => sum + row.amendments, 0),
    approvals: rows.reduce((sum, row) => sum + row.approvals, 0),
  };

  const rules = auditRules(root);
  const attention = [];
  if (counts.blind) attention.push(`${counts.blind} run(s) with no guard events (adapter not wired)`);
  if (counts.stranded) attention.push(`${counts.stranded} stranded run(s) (close with ratchet abandon --run <id>)`);
  if (counts.outsideRuns) attention.push(`${counts.outsideRuns} run(s) changed paths outside scope`);
  if (counts.checksFail) attention.push(`${counts.checksFail} run(s) with failing checks`);
  if (counts.open) attention.push(`${counts.open} open run(s) (finish with done or abandon)`);
  if (counts.noVerify) attention.push(`${counts.noVerify} run(s) with no verify command`);
  if (rules.configured && rules.errors.length) attention.push(`${rules.errors.length} rule(s) without an enforcer or proof`);

  return {
    version: 1,
    total: rows.length,
    counts,
    rules: rules.missing
      ? { configured: false, total: 0, errors: 0, warnings: 0 }
      : { configured: true, total: rules.rows.length, errors: rules.errors.length, warnings: rules.warnings.length },
    attention,
    rows,
  };
}
