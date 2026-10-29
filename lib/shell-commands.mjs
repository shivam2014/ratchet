// @ts-check
/**
 * Split a shell command line into simple commands, respecting quotes,
 * escapes, redirects, and heredocs. This is not a full bash parser: it models
 * the surface the guard needs and refuses the rest instead of guessing.
 *
 * The point is that hard policy rules run against `argv`, not against raw
 * text. `cat <<EOF ... git push --force ... EOF` is data; `git push --force`
 * is a command.
 */

/** @typedef {{ op: string, target: string, dup: boolean }} Redirect */
/** @typedef {{ delimiter: string, stripTabs: boolean, body: string, consumed: boolean }} Heredoc */
/** @typedef {{ argv: string[], redirects: Redirect[], heredocs: Heredoc[] }} ShellCommand */

const REDIRECT_OPS = [">>", "&>", ">&", "<<-", "<<", ">", "<"];

function consumeBalanced(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

export function parseCommands(source) {
  const text = String(source ?? "");
  /** @type {ShellCommand[]} */
  const commands = [];
  /** @type {ShellCommand} */
  let current = { argv: [], redirects: [], heredocs: [] };
  let word = "";
  let inWord = false;
  let quote = null;
  /** @type {string|null} */
  let pendingRedirect = null;
  let unsupported = null;
  let i = 0;

  const reset = () => {
    current = { argv: [], redirects: [], heredocs: [] };
  };

  const pushCommand = () => {
    if (current.argv.length || current.redirects.length || current.heredocs.length) commands.push(current);
    reset();
  };

  const flushWord = () => {
    if (!inWord) return;
    if (pendingRedirect === "<<-" || pendingRedirect === "<<") {
      current.heredocs.push({
        delimiter: word,
        stripTabs: pendingRedirect === "<<-",
        body: "",
        consumed: false,
      });
      pendingRedirect = null;
    } else if (pendingRedirect) {
      current.redirects.push({
        op: pendingRedirect,
        target: word,
        dup: (pendingRedirect === ">&" || pendingRedirect === "<&") && /^\d+$/.test(word),
      });
      pendingRedirect = null;
    } else {
      current.argv.push(word);
    }
    word = "";
    inWord = false;
  };

  const readHeredocs = () => {
    for (const heredoc of current.heredocs) {
      if (heredoc.consumed) continue;
      heredoc.consumed = true;
      while (i < text.length) {
        const eol = text.indexOf("\n", i);
        const end = eol === -1 ? text.length : eol;
        const line = text.slice(i, end);
        i = eol === -1 ? text.length : eol + 1;
        const compared = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (compared === heredoc.delimiter) break;
        heredoc.body += line + "\n";
      }
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      i++;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          if (next !== "\n") word += next;
          i += 2;
          continue;
        }
      }
      if (ch === "`" || (ch === "$" && text[i + 1] === "(")) unsupported = "command substitution";
      word += ch;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      i++;
      continue;
    }

    if (ch === "\\") {
      inWord = true;
      const next = text[i + 1];
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next !== undefined) {
        word += next;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      unsupported = "command substitution";
      if (ch === "`") {
        const end = text.indexOf("`", i + 1);
        word += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
        i = end === -1 ? text.length : end + 1;
      } else {
        const end = consumeBalanced(text, i + 1);
        word += text.slice(i, end);
        i = end;
      }
      inWord = true;
      continue;
    }

    if (ch === "#" && !inWord) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (ch === "\n") {
      flushWord();
      i++;
      readHeredocs();
      pushCommand();
      continue;
    }

    if (ch === ";") {
      flushWord();
      pushCommand();
      i++;
      continue;
    }

    if ((ch === "&" && text[i + 1] === "&") || (ch === "|" && text[i + 1] === "|")) {
      flushWord();
      pushCommand();
      i += 2;
      continue;
    }

    if (ch === "&" && text[i + 1] === ">") {
      if (pendingRedirect) unsupported = "redirect without a target";
      pendingRedirect = "&>";
      i += 2;
      while (text[i] === " " || text[i] === "\t") i++;
      continue;
    }

    if (ch === "|" || ch === "&") {
      flushWord();
      pushCommand();
      i++;
      continue;
    }

    if (ch === "(" || ch === ")") {
      flushWord();
      pushCommand();
      i++;
      continue;
    }

    if (ch === "<" || ch === ">") {
      if (ch === "<" && text[i + 1] === "(") {
        unsupported = "process substitution";
        i += 2;
        continue;
      }
      let op = null;
      for (const candidate of REDIRECT_OPS) {
        if (text.startsWith(candidate, i)) {
          op = candidate;
          break;
        }
      }
      if (!op) {
        word += ch;
        i++;
        continue;
      }
      // `2>file`: the descriptor is not an argument.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        flushWord();
      }
      if (pendingRedirect) unsupported = "redirect without a target";
      pendingRedirect = op;
      i += op.length;
      while (text[i] === " " || text[i] === "\t") i++;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      i++;
      continue;
    }

    if (ch === "$" && text[i + 1] === "'") {
      unsupported = "ANSI-C quoting";
    }

    word += ch;
    inWord = true;
    i++;
  }

  flushWord();
  if (pendingRedirect) unsupported = "redirect without a target";
  pushCommand();
  if (quote) unsupported = "unterminated quote";

  return { commands, unsupported };
}
