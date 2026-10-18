// @ts-check
import path from "node:path";
import { readText, stateDir } from "./fsx.mjs";

export const LAYERS = new Set(["code", "type", "lint", "test", "ci", "runtime", "prose"]);

/**
 * rules.tsv columns: rule, layer, enforcer, proof.
 * A rule that is not enforced by a machine is a wish, not a rule.
 */
export function parseRules(text) {
  const rows = [];
  const errors = [];
  const warnings = [];
  const lines = String(text || "").split("\n");

  lines.forEach((line, index) => {
    const n = index + 1;
    if (!line.trim() || line.startsWith("#")) return;
    const cells = line.split("\t").map((c) => c.trim());
    if (index === 0 && cells[0]?.toLowerCase() === "rule") return;
    if (cells.length < 4) {
      errors.push(`line ${n}: expected 4 tab-separated columns, got ${cells.length}`);
      return;
    }
    const [rule, layer, enforcer, proof] = cells;
    if (!rule) errors.push(`line ${n}: empty rule`);
    if (!LAYERS.has(layer)) errors.push(`line ${n}: unknown layer "${layer}"`);
    if (layer === "prose") {
      warnings.push(`line ${n}: "${rule}" is prose-only; nothing fails when an agent skips it`);
      if (!enforcer) errors.push(`line ${n}: prose rule needs an owner/enforcer label`);
    } else {
      if (!enforcer) errors.push(`line ${n}: "${rule}" has no enforcing mechanism`);
      if (!proof) errors.push(`line ${n}: "${rule}" has no proof that the check catches a real past mistake`);
    }
    rows.push({ rule, layer, enforcer, proof, line: n });
  });

  return { rows, errors, warnings };
}

export function auditRules(root) {
  const file = path.join(stateDir(root), "rules.tsv");
  const text = readText(file, "");
  if (!text) {
    return { file, rows: [], errors: [], warnings: ["no rules.tsv yet; add one rule per correction"], missing: true };
  }
  return { file, ...parseRules(text), missing: false };
}
