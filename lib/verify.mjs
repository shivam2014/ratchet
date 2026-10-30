// @ts-check

/** Commands that exit 0 without checking anything. */
const EXACT_NOOPS = new Set(["true", ":", "exit 0"]);

function isNoopSegment(segment) {
  const text = String(segment ?? "")
    .trim()
    .replace(/^\(+\s*/, "")
    .replace(/\s*\)+$/, "")
    .trim();
  if (!text) return true;
  if (EXACT_NOOPS.has(text)) return true;
  if (/^echo(?:\s|$)/.test(text)) return true;
  if (/^printf(?:\s|$)/.test(text)) return true;
  if (/^exit\s+0(?:\s|$)/.test(text)) return true;
  // `:` and `true` ignore their arguments, so `: ignored` and `true --quiet`
  // are just as empty as the bare command. `trueish` is not.
  if (/^:(?:\s|$)/.test(text)) return true;
  if (/^true(?:\s|$)/.test(text)) return true;
  return false;
}

/**
 * True when a command cannot fail: empty/whitespace, `true`, `:`, `echo ...`,
 * `printf ...`, or `exit 0`. Compound commands count only when every segment
 * is a no-op, so `echo ok && npm test` still verifies something.
 */
export function isNoopCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) return true;
  const segments = text
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return true;
  return segments.every(isNoopSegment);
}

/** Normalise verify entries (`{cmd}` or string) to trimmed command strings. */
export function verifyCommands(verify) {
  const list = Array.isArray(verify) ? verify : [];
  return list
    .map((entry) => (typeof entry === "string" ? entry : entry?.cmd))
    .map((command) => String(command ?? "").trim());
}

/**
 * Describe why a resolved verify list cannot certify work, or null when it can.
 * `kind: "empty"` means no commands; `kind: "noop"` names the commands that
 * can never fail.
 */
export function verifyProblem(verify) {
  const commands = verifyCommands(verify);
  if (!commands.length) return { kind: "empty", commands, noop: [] };
  const noop = commands.filter((command) => isNoopCommand(command));
  if (noop.length) return { kind: "noop", commands, noop };
  return null;
}
