#!/usr/bin/env node
/**
 * Trust the Ratchet Codex hook for the current CODEX_HOME by writing the
 * trust hash Codex expects. See lib/codex-trust.mjs for the algorithm.
 *
 * Prefer `ratchet install --harness codex --user`, which runs this
 * automatically. This script exists for one-off repair.
 */
import { installTrust } from "../../lib/codex-trust.mjs";

const result = installTrust(process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`);
if (!result.ok) {
  console.error(result.reason);
  process.exit(1);
}
console.log(`trusted ${result.key}`);
console.log(result.trusted);
