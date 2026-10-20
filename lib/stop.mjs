// @ts-check
import { checksPath, eventsPath, loadConfig, loadRun } from "./contract.mjs";
import { readJsonl, repoRel } from "./fsx.mjs";
import { runChecks, saveChecks } from "./checks.mjs";

export const DEFAULT_MAX_ATTEMPTS = 3;

/** The attempt count lives in the append-only trail, so it survives a crash. */
export function stopBlocks(root, runId) {
  return readJsonl(eventsPath(root, runId)).filter(
    (row) => row.type === "turn.stop" && row.decision === "block",
  ).length;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function failureText(result) {
  const text = String(result.stderr || "").trim() ? result.stderr : result.stdout;
  return String(text || "").split("\n").slice(-20).join("\n");
}

function uncertified(reason, attempts, maxAttempts, evidence = null) {
  return { allow: true, certified: false, reason, evidence, attempts, maxAttempts, checks: null };
}

export function evaluateStop(root, event, options = {}) {
  const configured = options.maxAttempts ?? loadConfig(root)?.stop?.maxAttempts;
  const maxAttempts = positiveInt(configured) ?? DEFAULT_MAX_ATTEMPTS;
  const contract = loadRun(root);

  if (!contract) {
    return uncertified("no active contract; the turn is uncertified", 0, maxAttempts);
  }
  if (!contract.verify?.length) {
    return uncertified("contract has no verify commands; the turn is uncertified", 0, maxAttempts);
  }

  const attempts = stopBlocks(root, contract.id);
  const evidence = repoRel(root, checksPath(root, contract.id));
  if (attempts >= maxAttempts) {
    return uncertified(`stop loop capped at ${maxAttempts} attempts; the turn is uncertified`, maxAttempts, maxAttempts, evidence);
  }

  const report = runChecks(root, contract.verify, { timeoutMs: options.timeoutMs });
  saveChecks(root, contract.id, report);
  const checks = {
    ok: report.ok,
    ranAt: report.ranAt,
    results: report.results.map((r) => ({ id: r.id, status: r.status })),
  };
  const next = attempts + 1;

  if (report.ok) {
    return { allow: true, certified: true, reason: null, evidence, attempts: next, maxAttempts, checks };
  }

  const failing = report.results.filter((r) => r.status !== 0);
  let reason = `checks failed: ${failing.map((r) => r.id).join(", ")}`;
  for (const result of failing) reason += `\n${failureText(result)}`;

  return {
    allow: false,
    certified: false,
    reason: reason.slice(0, 2000).trimEnd(),
    evidence,
    attempts: next,
    maxAttempts,
    checks,
  };
}
