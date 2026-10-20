#!/usr/bin/env node
/**
 * Trust the Ratchet Codex hooks for the current CODEX_HOME by writing the
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
for (const entry of result.entries) {
  console.log(`trusted ${entry.event} ${entry.key}`);
  console.log(entry.trusted);
}
