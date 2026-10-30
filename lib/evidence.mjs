// @ts-check
import path from "node:path";
import { checksPath, eventsPath, runDir } from "./contract.mjs";
import { readJson, readJsonl } from "./fsx.mjs";
import { auditRules } from "./rules.mjs";
import { taskChanges, taskScopeViolations } from "./scope-audit.mjs";

/**
 * The per-run certificate: what was promised, what checked it, what changed,
 * and which exceptions were recorded. It does not judge architecture quality.
 *
 * `options.ci` is the on-demand CI status attached by `evidence --ci`; the
 * default keeps the v1 `{recorded: false}` shape so JSON consumers do not
 * need to change.
 */
export function buildEvidence(root, contract, options = {}) {
  const checks = readJson(checksPath(root, contract.id), null);
  const result = readJson(path.join(runDir(root, contract.id), "result.json"), null);
  const events = readJsonl(eventsPath(root, contract.id));
  const rules = auditRules(root);
  const audit = result?.scopeAudit ?? null;
  const changed = audit?.changed ?? taskChanges(root, contract);
  const outside = audit?.outside ?? taskScopeViolations(root, contract);

  return {
    version: 1,
    run: contract.id,
    goal: contract.goal,
    role: contract.role,
    startedAt: contract.createdAt,
    finishedAt: result?.finishedAt ?? null,
    verdict: result?.verdict ?? "open",
    contract: {
      scope: contract.scope ?? [],
      deny: contract.deny ?? [],
      verify: (contract.verify ?? []).map((entry) => entry.cmd),
      budgets: contract.budgets ?? null,
      gates: (contract.gates ?? []).map((gate) => gate.artifact).filter(Boolean),
    },
    checks: checks
      ? {
          ok: Boolean(checks.ok),
          ranAt: checks.ranAt ?? null,
          results: (checks.results ?? []).map((entry) => ({
            id: entry.id,
            cmd: entry.cmd,
            status: entry.status,
            durationMs: entry.durationMs,
          })),
        }
      : null,
    changes: {
      changed,
      count: changed.length,
      outside,
      outsideCount: outside.length,
    },
    guard: {
      events: events.length,
      allow: events.filter((entry) => entry.decision === "allow").length,
      deny: events.filter((entry) => entry.decision === "deny").length,
      writes: result?.counts?.writes ?? null,
      unresolved: events.filter((entry) => entry.unresolved).length,
    },
    exceptions: {
      amendments: result?.amendments ?? contract.checkAmendments ?? [],
      approvals: result?.approvals ?? contract.approvals ?? [],
    },
    rules: rules.missing
      ? { configured: false, total: 0, errors: 0, warnings: 0 }
      : {
          configured: true,
          total: rules.rows.length,
          errors: rules.errors.length,
          warnings: rules.warnings.length,
        },
    ci: options.ci && typeof options.ci === "object" ? options.ci : { recorded: false },
  };
}

/** A clean run: done, checked, and every changed path inside scope. */
export function evidenceClean(evidence) {
  return evidence.verdict === "done" && evidence.checks?.ok === true && evidence.changes.outsideCount === 0;
}
