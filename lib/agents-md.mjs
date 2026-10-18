// @ts-check
import path from "node:path";
import { readText, writeText } from "./fsx.mjs";

export const MANAGED_START = "<!-- ratchet:begin -->";
export const MANAGED_END = "<!-- ratchet:end -->";

export const MANAGED = `${MANAGED_START}
## Ratchet workflow (managed)

Every non-trivial task starts with a contract and ends with evidence.

1. \`ratchet task start --role coder --goal "<goal>" --scope "<glob>"\`
2. Work. Writes outside the contract are denied by the adapter.
3. \`ratchet check\`
4. \`ratchet done\`

Rules are enforced in this order: architecture and types, lint and CI, tests, prose. Do not edit \`.ratchet/\`, bypass a hook with \`--no-verify\`, or widen scope silently.
${MANAGED_END}`;

/** Replace the managed block in AGENTS.md, or append it. Pure: returns the text. */
export function renderAgents(current) {
  if (current.includes(MANAGED_START) && current.includes(MANAGED_END)) {
    return current.replace(new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}`), MANAGED);
  }
  return (current.trimEnd() + "\n\n" + MANAGED + "\n").trimStart();
}

export function syncAgents(root, options = {}) {
  const file = path.join(root, "AGENTS.md");
  const current = readText(file, "");
  const next = renderAgents(current);
  const changed = next !== current;
  if (changed && !options.check) writeText(file, next);
  return { file, current, next, changed };
}
