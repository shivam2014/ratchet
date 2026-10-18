// @ts-check
/**
 * Coarse shell classifier. It answers one question: does this command mutate
 * files, and which paths does it name? It is deliberately conservative on
 * intent and honest about what it cannot resolve. The pi adapter can swap in
 * the mature classifier from the orchestrator extension.
 */

const HARD_DENY = [
  { re: /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|\/\*|~|\$HOME)(?:\s|$)/, why: "recursive delete of root or home" },
  { re: /\bgit\s+push\b[^\n]*(?:--force|-f)(?:\s|$)/, why: "force push" },
  { re: /\bgit\s+reset\s+--hard\b/, why: "hard reset destroys uncommitted work" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: "git clean deletes untracked files" },
  { re: /(?:^|[;&|]\s*)sudo\b/, why: "privilege escalation" },
  { re: /\bmkfs(?:\.\w+)?\b/, why: "filesystem format" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: "raw device write" },
  { re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\//, why: "world-writable root" },
];

const WRITE_VERBS = new Set([
  "rm", "rmdir", "mv", "cp", "install", "mkdir", "touch", "truncate",
  "dd", "tee", "chmod", "chown", "ln", "patch", "unzip", "tar", "rsync",
]);

const GIT_WRITE = new Set([
  "add", "rm", "mv", "checkout", "restore", "reset", "clean", "merge",
  "rebase", "cherry-pick", "commit", "push", "stash", "apply", "am",
]);

const PKG_WRITE = /^(?:npm|pnpm|yarn|bun)$/;
const PKG_WRITE_SUB = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "upgrade", "link", "publish"]);

const VALUE_FLAGS = new Set(["-m", "--message", "-e", "--expression", "-C", "--directory"]);

function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|") || ch === "|") {
      segments.push(current);
      current = "";
      if (command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote && segment[i - 1] !== "\\") quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

function redirectTargets(segment) {
  const out = [];
  const re = /(?:^|\s)\d*(?:>>?|&>)\s*([^\s;&|]+)/g;
  for (const m of segment.matchAll(re)) {
    const target = m[1];
    if (!target || target === "/dev/null" || /^&\d$/.test(target) || target === "&1" || target === "&2") continue;
    out.push(target);
  }
  return out;
}

function operands(tokens, start) {
  const out = [];
  let skip = false;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (skip) { skip = false; continue; }
    if (t === "--") continue;
    if (t.startsWith("-")) {
      if (VALUE_FLAGS.has(t)) skip = true;
      const eq = t.indexOf("=");
      if (eq > 0 && t.startsWith("--")) out.push(t.slice(eq + 1));
      continue;
    }
    if (t === ">" || t === ">>") { i++; continue; }
    if (t === "|" || t === "&&" || t === "||") break;
    out.push(t);
  }
  return out;
}

function cleanPath(p) {
  const v = String(p || "").trim();
  if (!v || v === "-" || v.startsWith("$") || v.startsWith("&")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null;
  return v;
}

export function classifyBash(command) {
  const text = String(command || "");
  const result = { write: false, paths: [], hardDeny: false, reason: null, notes: [] };

  for (const rule of HARD_DENY) {
    if (rule.re.test(text)) {
      return { ...result, write: true, hardDeny: true, reason: rule.why };
    }
  }

  for (const segment of splitSegments(text)) {
    const targets = redirectTargets(segment);
    if (targets.length) {
      result.write = true;
      result.paths.push(...targets);
    }

    const tokens = tokenize(segment);
    if (!tokens.length) continue;
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const cmd = tokens[i];
    if (!cmd) continue;

    if (cmd === "git") {
      const sub = tokens[i + 1];
      if (sub && GIT_WRITE.has(sub)) {
        result.write = true;
        if (sub === "add" || sub === "rm" || sub === "mv" || sub === "checkout" || sub === "restore") {
          result.paths.push(...operands(tokens, i + 2));
        }
      }
      continue;
    }

    if (PKG_WRITE.test(cmd)) {
      const sub = tokens[i + 1];
      if (sub && PKG_WRITE_SUB.has(sub)) {
        result.write = true;
        result.notes.push(`${cmd} ${sub} mutates build artifacts`);
      }
      continue;
    }

    if (cmd === "sed" || cmd === "perl") {
      if (tokens.includes("-i") || tokens.some((t) => /^-i/.test(t)) || tokens.includes("-pi")) {
        result.write = true;
        const args = operands(tokens, i + 1);
        // The first non-flag argument is the script, not a path.
        const paths = tokens[0] === "sed" || cmd === "sed" ? args.slice(1) : args;
        result.paths.push(...paths);
      }
      continue;
    }

    if (cmd === "python" || cmd === "python3" || cmd === "node" || cmd === "ruby") {
      if (tokens.some((t) => ["-c", "-e", "--eval", "-p", "--print"].includes(t))) {
        result.write = true;
        result.notes.push("inline interpreter code may write");
      }
      continue;
    }

    if (cmd === "find") {
      if (tokens.includes("-delete") || tokens.includes("-exec")) {
        result.write = true;
        result.notes.push("find can execute or delete");
      }
      continue;
    }

    if (WRITE_VERBS.has(cmd)) {
      result.write = true;
      const args = operands(tokens, i + 1).map(cleanPath).filter(Boolean);
      if (cmd === "cp" || cmd === "install" || cmd === "rsync" || cmd === "ln" || cmd === "unzip") {
        if (args.length) result.paths.push(args[args.length - 1]);
      } else if (cmd === "dd") {
        const of = tokens.find((t) => t.startsWith("of="));
        if (of) result.paths.push(of.slice(3));
      } else if (cmd === "tar") {
        result.notes.push("tar extraction target is not resolved");
      } else {
        result.paths.push(...args);
      }
    }
  }

  result.paths = [...new Set(result.paths.map(cleanPath).filter(Boolean))];
  return result;
}
