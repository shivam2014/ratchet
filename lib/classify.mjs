// @ts-check
/**
 * Coarse shell classifier. It answers one question: does this command mutate
 * files, and which paths does it name? It is deliberately conservative on
 * intent and honest about what it cannot resolve. The pi adapter can swap in
 * the mature classifier from the orchestrator extension.
 */
import path from "node:path";

const HARD_DENY = [
  { re: /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|\/\*|~|\$HOME)(?:\s|$)/, why: "recursive delete of root or home" },
  { re: /\bgit\s+push\b[^\n]*(?:--force|-f)(?:\s|$)/, why: "force push" },
  { re: /\bgit\s+reset\s+--hard\b/, why: "hard reset destroys uncommitted work" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: "git clean deletes untracked files" },
  { re: /(?:^|[;&|]\s*)sudo\b/, why: "privilege escalation" },
  { re: /\bmkfs(?:\.\w+)?\b/, why: "filesystem format" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: "raw device write" },
  { re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\//, why: "world-writable root" },
  { re: /\bratchet(?:\.mjs)?\b\s+(?:disable|uninstall|install|init|task\s+start)\b/, why: "guard-state mutation" },
  { re: /\bgit\s+commit\b[^\n]*\s--no-verify\b/, why: "commit hook bypass" },
  { re: /\bgit\s+config\b[^\n]*\bcore\.hooksPath\b/, why: "hook path override" },
];

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["env", "command", "nohup", "time"]);

const INLINE_INTERPRETERS = new Set(["python", "python3", "node", "ruby", "php", "bun", "deno"]);
const INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "eval"]);

/** A payload read from stdin is as opaque as `-e`: it names no paths. */
function readsStdin(tokens, segment, cmd) {
  if (tokens.includes("-")) return true;
  if (/<<-?\s*['"]?[A-Za-z_]/.test(segment)) return true;
  if (SHELLS.has(cmd) && tokens.includes("-s")) return true;
  return false;
}

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
    // Redirect tokens are not operands: `rm -rf build 2>/dev/null` names one
    // path, not two, and `2>/dev/null` is never in scope.
    if (/^\d*(?:>>?|&>)/.test(t)) continue;
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
  const v = String(p || "").trim().replace(/^['"]+|['"]+$/g, "");
  if (!v || v === "-" || v.startsWith("$") || v.startsWith("&")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null;
  return v;
}

/** Fold a recursively classified inner command into the outer result. */
function merge(result, inner, dir = null) {
  result.write = result.write || inner.write;
  result.inline = result.inline || inner.inline;
  for (const p of inner.paths) {
    result.paths.push(dir && !path.isAbsolute(p) ? path.posix.join(dir, p) : p);
  }
  result.notes.push(...inner.notes);
  if (inner.hardDeny) {
    result.hardDeny = true;
    result.reason = inner.reason;
  }
}

/** File paths named inside a unified diff or `apply_patch` body. */
function patchTargets(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    let match = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (match) {
      out.push(match[1].trim());
      continue;
    }
    match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) out.push(match[1].trim());
    match = line.match(/^\*\*\* Move to:\s*(.+)$/);
    if (match) out.push(match[1].trim());
  }
  return [...new Set(out)];
}

export function classifyBash(command) {
  const text = String(command || "");
  const result = { write: false, inline: false, paths: [], hardDeny: false, reason: null, notes: [] };

  // A leading `cd` changes what a later relative operand means. Track it so
  // `cd .git && rm config` is checked as `.git/config`, not `config`.
  let dir = null;
  const addPath = (p) => {
    const clean = cleanPath(p);
    if (!clean) return;
    result.paths.push(dir && !path.isAbsolute(clean) ? path.posix.join(dir, clean) : clean);
  };

  for (const rule of HARD_DENY) {
    if (rule.re.test(text)) {
      return { ...result, write: true, hardDeny: true, reason: rule.why };
    }
  }

  // Codex can run `apply_patch` through Bash as a heredoc. The patch body names
  // the files, so classify it as one write with those paths instead of letting
  // the heredoc lines fall through as unknown commands.
  if (/(?:^|[;&|]\s*)(?:apply_patch|git\s+apply|patch)\b/.test(text)) {
    const paths = patchTargets(text);
    if (paths.length) {
      return { ...result, write: true, paths, notes: ["patch body"] };
    }
  }

  for (const segment of splitSegments(text)) {
    const targets = redirectTargets(segment);
    if (targets.length) {
      result.write = true;
      for (const t of targets) addPath(t);
    }

    const tokens = tokenize(segment);
    if (!tokens.length) continue;
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const cmd = tokens[i]?.replace(/^\(+/, "");
    if (!cmd) continue;

    if (cmd === "cd") {
      const target = operands(tokens, i + 1)[0];
      if (!target) {
        dir = process.env.HOME || path.sep;
      } else if (target === "-" || target.startsWith("$")) {
        // The previous directory or a variable is not resolvable. Resolve
        // later relative paths against the filesystem root so they fall
        // outside the repo instead of being silently checked in the repo.
        dir = path.sep;
      } else if (target === "~") {
        dir = process.env.HOME || path.sep;
      } else if (target.startsWith("~/")) {
        dir = path.posix.join(process.env.HOME || path.sep, target.slice(2));
      } else if (target.startsWith("~")) {
        dir = path.sep;
      } else if (path.isAbsolute(target)) {
        dir = target;
      } else {
        dir = dir ? path.posix.join(dir, target) : target;
      }
      continue;
    }

    // A shell wrapper hides the real command from the segment scanner. Recurse
    // into the wrapped command instead of treating the wrapper as a read. A
    // heredoc or `-s` payload has no command to recurse into.
    if (SHELLS.has(cmd)) {
      const args = tokens.slice(i + 1);
      const c = tokens.findIndex((t, idx) => idx > i && /^-[a-zA-Z]*c$/.test(t));
      if (c > 0 && tokens[c + 1] !== undefined) {
        merge(result, classifyBash(tokens.slice(c + 1).join(" ")), dir);
      } else if (readsStdin(args, segment, cmd)) {
        result.write = true;
        result.inline = true;
        result.notes.push("inline interpreter code may write");
      }
      continue;
    }

    if (WRAPPERS.has(cmd)) {
      let j = i + 1;
      while (j < tokens.length) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j])) { j++; continue; }
        if (tokens[j] === "-u" || tokens[j] === "--unset" || tokens[j] === "-C" || tokens[j] === "--chdir") { j += 2; continue; }
        if (tokens[j].startsWith("-")) { j++; continue; }
        break;
      }
      if (j < tokens.length) merge(result, classifyBash(tokens.slice(j).join(" ")), dir);
      continue;
    }

    if (cmd === "git") {
      // Skip git global options so `git -C src add a.ts` is classified as a
      // write and the path is rebased onto the -C directory.
      let j = i + 1;
      let base = "";
      while (j < tokens.length && tokens[j].startsWith("-")) {
        const flag = tokens[j];
        if (flag === "-C" || flag === "--git-dir" || flag === "--work-tree") {
          base = tokens[j + 1] ?? base;
          j += 2;
          continue;
        }
        if (flag === "-c") {
          j += 2;
          continue;
        }
        j += 1;
      }
      const sub = tokens[j];
      if (sub && GIT_WRITE.has(sub)) {
        result.write = true;
        if (sub === "add" || sub === "rm" || sub === "mv" || sub === "checkout" || sub === "restore") {
          const args = operands(tokens, j + 1);
          for (const arg of args) {
            if (!base || arg.startsWith("/") || arg.startsWith("~")) addPath(arg);
            else addPath(`${base.replace(/\/$/, "")}/${arg}`);
          }
        }
      }
      continue;
    }

    // `bun -e` must be checked before the package-manager branch claims `bun`.
    if (INLINE_INTERPRETERS.has(cmd)) {
      const args = tokens.slice(i + 1);
      const code = args.some((t) => INLINE_FLAGS.has(t)) || (cmd === "php" && args.includes("-r"));
      if (code || readsStdin(args, segment, cmd)) {
        result.write = true;
        result.inline = true;
        result.notes.push("inline interpreter code may write");
        continue;
      }
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
      if (tokens.includes("-i") || tokens.some((t) => /^(?:-i|--in-place)/.test(t)) || tokens.includes("-pi")) {
        result.write = true;
        const args = operands(tokens, i + 1);
        // The first non-flag argument is the script, not a path.
        const paths = tokens[0] === "sed" || cmd === "sed" ? args.slice(1) : args;
        for (const p of paths) addPath(p);
      } else if (cmd === "perl" && (tokens.some((t) => t === "-e" || t === "--eval") || readsStdin(tokens, segment, cmd))) {
        result.write = true;
        result.inline = true;
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
        if (args.length) addPath(args[args.length - 1]);
      } else if (cmd === "dd") {
        const of = tokens.find((t) => t.startsWith("of="));
        if (of) addPath(of.slice(3));
      } else if (cmd === "tar") {
        result.notes.push("tar extraction target is not resolved");
      } else {
        for (const p of args) addPath(p);
      }
    }
  }

  result.paths = [...new Set(result.paths.map(cleanPath).filter(Boolean))];
  return result;
}
