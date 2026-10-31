// @ts-check
/**
 * Windows command classifier. It answers the same question as the POSIX
 * classifier - does this command mutate files, and which paths does it name -
 * for cmd.exe and PowerShell payloads.
 *
 * This is a lexical parser, not a real Windows shell. It reads command names,
 * flags, and operands from the text, never resolves anything against the
 * filesystem, and refuses to guess when a payload is opaque (`-EncodedCommand`,
 * `Invoke-Expression`, variable-driven paths). Drive letters and UNC prefixes
 * are recognised lexically so the classifier runs on macOS and Linux too.
 */

export const WINDOWS_HARD_RULES = {
  "windows-format": { why: "filesystem format", approvable: false },
  "windows-diskpart": { why: "disk partitioning", approvable: false },
  "windows-boot-config": { why: "boot configuration edit", approvable: false },
  "windows-reg-delete": { why: "registry delete", approvable: false },
  "windows-root-delete": { why: "recursive delete of a drive root", approvable: false },
  "windows-shutdown": { why: "system shutdown or restart", approvable: false },
};

const CMD_NAMES = new Set(["cmd", "command"]);
const PS_NAMES = new Set(["powershell", "pwsh"]);

const POWERSHELL_DELETE = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
const POWERSHELL_CONTENT = new Set(["set-content", "sc", "add-content", "ac", "out-file", "clear-content", "clc"]);
const POWERSHELL_NEW_ITEM = new Set(["new-item", "ni", "mkdir", "md"]);
const POWERSHELL_COPY = new Set(["copy-item", "cpi", "cp", "copy"]);
const POWERSHELL_MOVE = new Set(["move-item", "mi", "mv", "move"]);
const POWERSHELL_RENAME = new Set(["rename-item", "rni", "ren", "rename"]);
const POWERSHELL_PROPERTY = new Set(["set-itemproperty", "sp", "remove-itemproperty", "rp", "new-itemproperty"]);
const START_PROCESS = new Set(["start-process", "saps", "start"]);

/** Commands that change the working directory for later relative operands. */
const CMD_LOCATION = new Set(["cd", "chdir", "pushd", "popd"]);
const PS_LOCATION = new Set(["cd", "chdir", "set-location", "sl", "push-location", "pop-location"]);

/** Full cmdlet names are unambiguous PowerShell; their aliases are not. */
const POWERSHELL_CMDLETS = new Set([
  "remove-item", "set-content", "add-content", "out-file", "new-item", "copy-item",
  "move-item", "rename-item", "clear-content", "set-itemproperty",
  "remove-itemproperty", "new-itemproperty", "start-process", "invoke-expression",
]);

const CMD_DELETE = new Set(["del", "erase", "rd", "rmdir"]);
const CMD_MAKE = new Set(["mkdir", "md"]);
const CMD_COPY = new Set(["copy"]);
const CMD_MOVE = new Set(["move"]);
const CMD_RENAME = new Set(["ren", "rename"]);
const CMD_REPLACE = new Set(["replace"]);
const CMD_ATTRIB = new Set(["attrib"]);
const CMD_ACL = new Set(["icacls", "takeown"]);
const CMD_ROBO = new Set(["robocopy", "xcopy"]);

/**
 * Bare verbs that are a Windows mutation even without a cmd/powershell
 * wrapper. Deliberately excludes names Git Bash also owns (`rm`, `cp`, `mv`,
 * `mkdir`, `rmdir`, `rename`); those go through the POSIX parser unless a
 * cmd/powershell context or a drive path says otherwise.
 */
const WINDOWS_VERBS = new Set([
  "del", "erase", "rd",
  "copy", "move", "ren", "replace", "attrib", "icacls", "takeown", "robocopy", "xcopy",
  "remove-item", "ri", "set-content", "add-content", "out-file", "clear-content",
  "new-item", "ni", "copy-item", "cpi", "move-item", "mi", "rename-item", "rni",
  "set-itemproperty", "remove-itemproperty", "new-itemproperty",
]);

/** cmd.exe switches. Short flags are single letters; the rest are the long
 * robocopy/icacls names the guard actually sees. Everything with a colon is a
 * switch value, except `/log:file`, which names an output file. */
const CMD_LONG_FLAGS = new Set([
  "mir", "purge", "nocopy", "copyall", "mov", "move", "create", "nfl", "ndl",
  "xj", "xc", "xn", "xd", "xf", "xa", "xb", "xo", "xx", "xl", "unilog", "tee",
  "np", "njh", "njs", "fp", "dst", "dcopy", "eta", "reg", "tbd", "sl", "bj",
  "zb", "efsraw", "disablerobust", "grant", "deny", "remove", "setowner",
  "reset", "save", "restore", "inheritance",
]);

/** PowerShell parameters whose value is a path the command writes. */
const PS_PATH_PARAMS = new Set([
  "path", "literalpath", "pspath", "filepath", "destination", "newpath", "outfile",
]);

/** PowerShell parameters whose value is data, not a path. */
const PS_VALUE_PARAMS = new Set([
  "value", "inputobject", "encoding", "filter", "include", "exclude", "credential",
  "stream", "delimiter", "separator", "name", "itemtype", "type", "property",
  "displayname", "description", "confirm", "erroraction", "warningaction",
  "informationaction", "errorvariable", "warningvariable", "outvariable",
  "outbuffer", "pipelinevariable", "depth", "membertype", "language", "totalcount",
  "first", "last", "skip", "index", "head", "tail", "whatif", "minimum", "maximum",
  "count", "replace", "pattern", "algorithm", "keysize", "namespace", "scope",
  "option", "argumentlist", "windowstyle", "verb", "workingdirectory", "cert",
  "thumbprint", "location", "provider", "root", "expandproperty", "culture",
]);

const PS_REDIRECT_PARAMS = ["redirectstandardoutput", "redirectstandarderror", "redirectstandardinput"];

const CMD_SC_SUBCOMMANDS = new Set([
  "query", "queryex", "start", "stop", "pause", "continue", "config", "create",
  "delete", "description", "failure", "failureflag", "interrogate", "qc", "qdescription",
  "qfailure", "qfailureflag", "qprivs", "qprotected", "qsecurity", "qtriggerinfo",
  "sdshow", "sdset", "showsid", "triggerinfo", "enumdepend", "getdisplayname",
  "getkeyname", "control", "privs", "managedproduct", "lock",
]);

const DEVICE_TARGETS = new Set(["/dev/null", "nul", "con", "prn", "aux", "clock$"]);

function empty() {
  return {
    write: false,
    inline: false,
    paths: [],
    hardDeny: false,
    hardRule: null,
    reason: null,
    notes: [],
    detected: false,
  };
}

function stripQuotes(value) {
  return String(value ?? "").trim().replace(/^['"]+|['"]+$/g, "");
}

function stripOuterQuotes(value) {
  const text = String(value ?? "").trim();
  if (text.length < 2) return text;
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return text;
  if (text[text.length - 1] !== quote) return text;
  // Backslash does not escape a quote in cmd or PowerShell, so count the raw
  // quote characters: one pair wraps the payload, two pairs are separate args.
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === quote) count++;
  }
  return count === 2 ? text.slice(1, -1) : text;
}

/** The command name without a directory or executable suffix. */
export function windowsBaseName(word) {
  const raw = stripQuotes(word);
  const parts = raw.split(/[\\/]/);
  const base = (parts.pop() || "").toLowerCase();
  return base.replace(/\.(?:exe|com|bat|cmd|ps1|psm1)$/i, "");
}

/** A drive-letter or UNC path, recognised without path.win32. */
export function isWindowsAbsolutePath(value) {
  const text = stripQuotes(value);
  if (!text) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  if (/^\\\\[^\\/\s]+[\\/][^\\/\s]+/.test(text)) return true;
  return false;
}

function isDrivePath(value) {
  return /^[A-Za-z]:[\\/]?/.test(stripQuotes(value));
}

function isDriveVolume(value) {
  return /^[A-Za-z]:[\\/]?$/.test(stripQuotes(value)) || /^\\\\\?\\volume\{/i.test(stripQuotes(value));
}

function isRootTarget(value) {
  const text = stripQuotes(value);
  if (/^[A-Za-z]:[\\/]?$/.test(text)) return true;
  if (/^[A-Za-z]:[\\/]\*\.?\*?$/.test(text)) return true;
  if (text === "/" || text === "\\" || text === "\\\\") return true;
  if (/^%SystemDrive%[\\/]?$/i.test(text)) return true;
  if (/^\$env:SystemDrive[\\/]?$/i.test(text)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/.test(text);
}

function isDynamic(value) {
  const text = stripQuotes(value);
  return text.includes("$") || /\$\(/.test(text) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(text) || text.includes("`");
}

function looksLikePath(value) {
  const text = stripQuotes(value);
  return Boolean(text) && (isDrivePath(text) || text.includes("\\") || text.includes("/") || text.includes("."));
}

/** A rename's new name, resolved against the item's parent directory. */
function joinWindowsParent(target, name) {
  const child = stripQuotes(name);
  const parent = stripQuotes(target ?? "");
  if (!child) return null;
  if (isWindowsAbsolutePath(child) || /^[A-Za-z]:/.test(child) || child.startsWith("/") || child.startsWith("\\")) return child;
  if (!parent) return child;
  const match = parent.match(/^(.*[\\/])[^\\/]*$/);
  return match ? `${match[1]}${child}` : child;
}

/** Lexically collapse `.` and `..` in a Windows path. Never touches disk. */
function normaliseWindowsPath(value) {
  const text = stripQuotes(value);
  let prefix = "";
  let rest = text;
  const drive = text.match(/^([A-Za-z]:)[\\/](.*)$/);
  const unc = text.match(/^\\\\[^\\/]+[\\/][^\\/]+[\\/]?(.*)$/);
  if (drive) {
    prefix = `${drive[1]}\\`;
    rest = drive[2];
  } else if (unc) {
    const root = text.split(/[\\/]+/).filter(Boolean).slice(0, 2).join("\\");
    prefix = `\\\\${root}\\`;
    rest = unc[1];
  }
  const segments = [];
  for (const segment of rest.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length && segments[segments.length - 1] !== "..") segments.pop();
      else if (!prefix) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join("\\")}`;
}

/** Resolve a relative operand against a tracked `cd` directory. */
function joinWindowsDir(dir, target) {
  const child = stripQuotes(target);
  if (!dir) return child;
  if (isWindowsAbsolutePath(child) || /^[A-Za-z]:/.test(child) || child.startsWith("/") || child.startsWith("\\")) return child;
  return normaliseWindowsPath(`${dir.replace(/[\\/]+$/, "")}\\${child}`);
}

/** Flags: PowerShell style `-Recurse`, cmd style `/s`, attrib style `+r`. */
function isFlag(value) {
  const text = stripQuotes(value);
  if (!text) return true;
  if (text.startsWith("-")) return true;
  if (/^\/[A-Za-z]{1,2}$/.test(text)) return true;
  if (/^\/[A-Za-z][A-Za-z0-9]*:/.test(text)) return true;
  if (CMD_LONG_FLAGS.has(text.slice(1).toLowerCase()) && text.startsWith("/")) return true;
  if (/^[+-][A-Za-z]{1,3}$/.test(text)) return true;
  return false;
}

function cleanPath(value) {
  const text = stripQuotes(value);
  if (!text || text === "-") return null;
  if (isFlag(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  return text;
}

function redirectTargets(segment) {
  const out = [];
  const re = /(?:^|\s)(?:\d|\*)?(?:>>?)\s*("([^"]*)"|'([^']*)'|([^\s;&|]+))/g;
  for (const match of segment.matchAll(re)) {
    const target = match[2] ?? match[3] ?? match[4] ?? "";
    if (!target) continue;
    const lower = target.toLowerCase();
    if (DEVICE_TARGETS.has(lower) || /^&\d$/.test(target) || /^\d$/.test(target)) continue;
    out.push(target);
  }
  return out;
}

/** Split on cmd/PowerShell statement separators, respecting quotes. */
function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      segments.push(current);
      current = "";
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Drop POSIX heredoc bodies. Windows has no heredoc, and a body is data: a
 * patch or note that contains `format C:` must not become a hard rule.
 */
function heredocDelimiter(line) {
  // A `#` comment is not a command, and its `<<` is prose.
  if (/^\s*#/.test(line)) return null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue;
    const rest = line.slice(i + 2).replace(/^-/, "");
    const match = rest.match(/^\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/);
    const delimiter = match && (match[1] ?? match[2] ?? match[3]);
    if (delimiter) return delimiter;
  }
  return null;
}

function stripPosixHeredocs(command) {
  const lines = command.split(/\r?\n/);
  const out = [];
  let delimiter = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line === delimiter || line.replace(/^\t+/, "") === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    delimiter = heredocDelimiter(line);
  }
  return out.join("\n");
}

function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let start = 0;
  const flush = (end) => {
    if (!current && !quote) return;
    tokens.push({ value: current, start, end });
    current = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (!current) start = i;
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush(i);
      continue;
    }
    if (!current) start = i;
    current += ch;
  }
  flush(segment.length);
  return { tokens, unsupported: quote ? "unterminated quote" : null };
}

function commandIndex(tokens) {
  let i = 0;
  // `@echo off` and PowerShell variable assignments are not commands.
  while (i < tokens.length && tokens[i].value.startsWith("@")) i++;
  if (i < tokens.length && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[i].value) && tokens[i + 1]?.value === "=") return -1;
  return i < tokens.length ? i : -1;
}

/** Raw text after one token, with a single pair of wrapping quotes removed. */
function payloadFrom(index, matchText, segment, token) {
  const inline = String(matchText ?? "").replace(/^:/, "");
  const rest = segment.slice(token.end).trim();
  return stripOuterQuotes([inline, rest].filter(Boolean).join(" "));
}

function parsePowerShell(args) {
  const positional = [];
  const paths = [];
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const text = stripQuotes(args[i]);
    const match = text.match(/^-([A-Za-z][A-Za-z0-9]*)(?::(.*))?$/);
    if (!match) {
      if (!isFlag(text)) positional.push(text);
      continue;
    }
    const name = match[1].toLowerCase();
    flags.add(name);
    const inline = match[2];
    if (PS_PATH_PARAMS.has(name)) {
      const value = inline !== undefined ? inline : args[i + 1];
      if (value !== undefined) {
        paths.push(stripQuotes(value));
        if (inline === undefined) i++;
      }
      continue;
    }
    if (PS_VALUE_PARAMS.has(name)) {
      if (inline === undefined) i++;
      continue;
    }
  }
  return { positional, paths, flags };
}

function parseCmd(args) {
  const positional = [];
  const paths = [];
  for (const raw of args) {
    const text = stripQuotes(raw);
    if (!text) continue;
    const log = text.match(/^\/log:(.+)$/i);
    if (log) {
      paths.push(log[1]);
      continue;
    }
    if (isFlag(text)) continue;
    positional.push(text);
  }
  return { positional, paths };
}

function flagValues(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const text = stripQuotes(args[i]);
    const match = text.match(/^-([A-Za-z][A-Za-z0-9]*)(?::(.*))?$/);
    if (!match || !names.includes(match[1].toLowerCase())) continue;
    const value = match[2] !== undefined ? match[2] : args[i + 1];
    if (value !== undefined) {
      out.push(stripQuotes(value));
      if (match[2] === undefined) i++;
    }
  }
  return out;
}

function segmentHasWindowsPath(segment, tokens) {
  if (tokens.some((token) => isWindowsAbsolutePath(token.value))) return true;
  return (
    /(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)/.test(segment) ||
    /%[A-Za-z_][A-Za-z0-9_]*%/.test(segment)
  );
}

function hardRule(id) {
  return { id, ...WINDOWS_HARD_RULES[id] };
}

function windowsHardRuleFor(name, args, platform, context) {
  if (name === "format" && args.some((arg) => isDriveVolume(arg.value))) {
    return hardRule("windows-format");
  }
  if (name === "diskpart") return hardRule("windows-diskpart");
  if (name === "bcdedit") return hardRule("windows-boot-config");
  if (name === "reg") {
    const sub = args.map((arg) => stripQuotes(arg.value).toLowerCase()).find((arg) => !arg.startsWith("/") && !arg.startsWith("-"));
    if (sub === "delete") return hardRule("windows-reg-delete");
  }
  if (name === "shutdown") {
    const destructive = args.some((arg) => /^[\/-][rs]$/i.test(stripQuotes(arg.value)));
    if (destructive) return hardRule("windows-shutdown");
  }

  const windowsOnly = ["del", "erase", "rd", "remove-item", "ri"].includes(name);
  const posixOverlap = ["rm", "rmdir"].includes(name);
  if (!windowsOnly && !(posixOverlap && (platform === "win32" || context === "ps"))) return null;
  if (!POWERSHELL_DELETE.has(name) && !CMD_DELETE.has(name)) return null;

  const raw = args.map((arg) => arg.value);
  let recursive = false;
  let force = false;
  for (const value of raw) {
    const text = stripQuotes(value).toLowerCase();
    if (context === "ps" || text.startsWith("-")) {
      if (/^-(?:recurse|r|rf|fr)$/.test(text)) recursive = true;
      if (/^-(?:force|fo|rf|fr)$/.test(text)) force = true;
    }
    if (/^\/s$/.test(text)) recursive = true;
    if (/^\/q$/.test(text)) force = true;
  }
  if (!recursive || !force) return null;

  const parsed = context === "ps" ? parsePowerShell(raw) : parseCmd(raw);
  const operands = [...parsed.paths, ...parsed.positional];
  if (operands.some((value) => isRootTarget(value))) return hardRule("windows-root-delete");
  return null;
}

function addPath(result, value, state = null) {
  let clean = cleanPath(value);
  if (!clean) return false;
  if (isDynamic(clean)) {
    result.inline = true;
    result.notes.push("dynamic path cannot be resolved");
    return false;
  }
  const relative = !isWindowsAbsolutePath(clean) && !/^[A-Za-z]:/.test(clean) && !clean.startsWith("/") && !clean.startsWith("\\");
  if (state && relative) {
    if (state.dir) clean = joinWindowsDir(state.dir, clean);
    else if (state.unresolved) {
      result.inline = true;
      result.notes.push("relative path after an unresolved directory change");
      return false;
    }
  }
  result.paths.push(clean);
  return true;
}

function merge(result, inner) {
  result.write = result.write || inner.write;
  result.inline = result.inline || inner.inline;
  result.paths.push(...inner.paths);
  result.notes.push(...inner.notes);
  result.detected = result.detected || inner.detected;
  if (inner.hardDeny) {
    result.hardDeny = true;
    result.hardRule = inner.hardRule;
    result.reason = inner.reason;
  }
}

function classifyWrite(result, name, args, context, state = null) {
  result.write = true;

  if (context === "ps") {
    const parsed = parsePowerShell(args);
    if (POWERSHELL_COPY.has(name) || POWERSHELL_MOVE.has(name)) {
      const destination = flagValues(args, ["destination"]).at(-1) ?? parsed.positional.at(-1) ?? parsed.paths.at(-1);
      if (destination) addPath(result, destination, state);
      return;
    }
    if (POWERSHELL_RENAME.has(name)) {
      const target = parsed.paths[0] ?? parsed.positional[0];
      if (target) addPath(result, target, state);
      const newName = flagValues(args, ["newname"]).at(-1) ?? parsed.positional[1];
      if (newName) addPath(result, joinWindowsParent(target, newName), state);
      return;
    }
    if (POWERSHELL_CONTENT.has(name)) {
      const target = parsed.paths[0] ?? parsed.positional[0];
      if (target) addPath(result, target, state);
      return;
    }
    if (POWERSHELL_PROPERTY.has(name)) {
      const target = parsed.paths[0] ?? parsed.positional[0];
      if (target) addPath(result, target, state);
      return;
    }
    if (POWERSHELL_DELETE.has(name) || POWERSHELL_NEW_ITEM.has(name)) {
      for (const value of [...parsed.paths, ...parsed.positional]) addPath(result, value, state);
      return;
    }
  }

  if (CMD_COPY.has(name) || CMD_MOVE.has(name)) {
    const parsed = parseCmd(args);
    const destination = parsed.positional.at(-1);
    if (destination) addPath(result, destination, state);
    return;
  }
  if (CMD_REPLACE.has(name)) {
    const parsed = parseCmd(args);
    const destination = parsed.positional[1] ?? parsed.positional[0];
    if (destination) addPath(result, destination, state);
    return;
  }
  if (CMD_RENAME.has(name)) {
    const parsed = parseCmd(args);
    const target = parsed.positional[0];
    if (target) addPath(result, target, state);
    if (parsed.positional[1]) addPath(result, joinWindowsParent(target, parsed.positional[1]), state);
    return;
  }
  if (CMD_ROBO.has(name)) {
    const parsed = parseCmd(args);
    const destination = parsed.positional[1] ?? parsed.positional[0];
    for (const value of parsed.paths) addPath(result, value, state);
    if (destination) addPath(result, destination, state);
    return;
  }
  if (CMD_ACL.has(name)) {
    const parsed = parseCmd(args);
    const target = parsed.positional[0];
    for (const value of parsed.paths) addPath(result, value, state);
    if (target) addPath(result, target, state);
    return;
  }
  if (CMD_ATTRIB.has(name) || CMD_DELETE.has(name) || CMD_MAKE.has(name)) {
    const parsed = parseCmd(args);
    for (const value of parsed.paths) addPath(result, value, state);
    for (const value of parsed.positional) addPath(result, value, state);
  }
}

function classifyPowerShellCommand(result, name, args, state = null) {
  const raw = args.map((arg) => (typeof arg === "string" ? arg : arg.value));
  if (name === "invoke-expression" || name === "iex") {
    result.write = true;
    result.inline = true;
    result.notes.push("PowerShell Invoke-Expression cannot be inspected");
    return true;
  }
  if (START_PROCESS.has(name)) {
    const values = flagValues(raw, PS_REDIRECT_PARAMS);
    if (values.length) {
      result.write = true;
      for (const value of values) addPath(result, value, state);
    }
    return true;
  }
  if (POWERSHELL_DELETE.has(name) || POWERSHELL_CONTENT.has(name) || POWERSHELL_NEW_ITEM.has(name)) {
    classifyWrite(result, name, raw, "ps", state);
    return true;
  }
  if (POWERSHELL_COPY.has(name) || POWERSHELL_MOVE.has(name) || POWERSHELL_RENAME.has(name) || POWERSHELL_PROPERTY.has(name)) {
    classifyWrite(result, name, raw, "ps", state);
    return true;
  }
  return false;
}

function classifyCmdCommand(result, name, args, state = null) {
  const writeVerb =
    CMD_DELETE.has(name) || CMD_MAKE.has(name) || CMD_COPY.has(name) || CMD_MOVE.has(name) ||
    CMD_RENAME.has(name) || CMD_REPLACE.has(name) || CMD_ATTRIB.has(name) || CMD_ACL.has(name) ||
    CMD_ROBO.has(name) ||
    // PowerShell aliases are valid in cmd only when a PowerShell shell is
    // running the payload; the auto context also sees them on win32.
    POWERSHELL_CONTENT.has(name) || POWERSHELL_COPY.has(name) || POWERSHELL_MOVE.has(name) ||
    POWERSHELL_RENAME.has(name) || POWERSHELL_NEW_ITEM.has(name) || POWERSHELL_DELETE.has(name);
  if (!writeVerb) return false;
  classifyWrite(result, name, args, "cmd", state);
  return true;
}

/** Track `cd` / `Set-Location` so later relative operands are resolved. */
function applyLocation(name, args, context, state) {
  if (!state) return;
  if (name === "popd" || name === "pop-location") {
    state.dir = state.stack.pop() ?? null;
    state.unresolved = false;
    return;
  }
  if (name === "pushd" || name === "push-location") state.stack.push(state.dir);

  const raw = args.map((arg) => arg.value);
  let target;
  if (context === "ps") {
    const parsed = parsePowerShell(raw);
    target = parsed.paths[0] ?? parsed.positional[0];
  } else {
    target = parseCmd(raw).positional[0];
  }
  if (target === undefined) {
    // A bare `cd` in PowerShell goes to the user's home, which is not known
    // here. cmd's bare `cd` only prints the current directory.
    if (context === "ps") {
      state.dir = null;
      state.unresolved = true;
    }
    return;
  }
  if (isDynamic(target)) {
    state.dir = null;
    state.unresolved = true;
    return;
  }
  state.dir = joinWindowsDir(state.dir, target);
  state.unresolved = false;
}

function classifySegment(result, segment, options) {
  const platform = options.platform;
  const context = options.context;
  const state = options.state ?? null;
  const { tokens, unsupported } = tokenize(segment);
  if (!tokens.length) return;
  const index = commandIndex(tokens);
  if (index < 0) return;

  const name = windowsBaseName(tokens[index].value);
  const args = tokens.slice(index + 1);
  const wrapper = CMD_NAMES.has(name) || PS_NAMES.has(name);
  const signal =
    options.forced ||
    wrapper ||
    POWERSHELL_CMDLETS.has(name) ||
    context !== "auto" ||
    options.force ||
    ((options.force || platform === "win32") && WINDOWS_VERBS.has(name)) ||
    segmentHasWindowsPath(segment, tokens);

  const rule = windowsHardRuleFor(name, args, platform, context);
  if (rule) {
    result.write = true;
    result.detected = true;
    result.hardDeny = true;
    result.hardRule = rule.id;
    result.reason = rule.why;
    result.notes.push(`windows hard rule: ${rule.id}`);
    return;
  }

  if (!signal) return;
  result.detected = true;

  // `& $exe`, `%COMSPEC% /c ...`: the program itself is data, so the payload
  // cannot be resolved.
  if (name.startsWith("$") || name.startsWith("%") || name.startsWith("(")) {
    result.write = true;
    result.inline = true;
    result.notes.push("dynamic command cannot be resolved");
    return;
  }

  if (unsupported) {
    result.write = true;
    result.inline = true;
    result.notes.push(`unresolved windows construct: ${unsupported}`);
    return;
  }

  for (const target of redirectTargets(segment)) {
    result.write = true;
    addPath(result, target, state);
  }

  if (state && (CMD_LOCATION.has(name) || PS_LOCATION.has(name))) {
    applyLocation(name, args, context === "cmd" ? "cmd" : "ps", state);
    return;
  }

  /** Carry a tracked directory into a nested shell payload. */
  const withDirectory = (payload, shell) => {
    if (!state?.dir) return payload;
    if (shell === "cmd") return `cd /d "${state.dir}" && ${payload}`;
    return `Set-Location -LiteralPath '${String(state.dir).replace(/'/g, "''")}'; ${payload}`;
  };

  if (CMD_NAMES.has(name)) {
    for (let i = index + 1; i < tokens.length; i++) {
      const match = stripQuotes(tokens[i].value).match(/^\/([ck])(.*)$/i);
      if (!match) continue;
      const payload = payloadFrom(i, match[2], segment, tokens[i]);
      if (!payload) return;
      const nested = withDirectory(payload, "cmd");
      const inner = options.classifyInner
        ? options.classifyInner(nested, "cmd")
        : classifyWindows(nested, { platform: "win32", context: "cmd" });
      merge(result, inner);
      return;
    }
    // `cmd` without `/c` or `/k` is an interactive shell; it runs nothing.
    return;
  }

  if (PS_NAMES.has(name)) {
    const rawArgs = args.map((arg) => arg.value);
    const encoded = rawArgs.some((value) => /^-(?:encodedcommand|enc|ec|e)(?::|$)/i.test(stripQuotes(value)));
    if (encoded) {
      result.write = true;
      result.inline = true;
      result.notes.push("PowerShell -EncodedCommand cannot be inspected");
      return;
    }
    const file = rawArgs.some((value) => /^-(?:file|f)(?::|$)/i.test(stripQuotes(value)));
    if (file) {
      result.write = true;
      result.inline = true;
      result.notes.push("PowerShell script file cannot be inspected");
      return;
    }
    for (let i = index + 1; i < tokens.length; i++) {
      const match = stripQuotes(tokens[i].value).match(/^-(?:command|commandwithargs|c)(?::(.*))?$/i);
      if (!match) continue;
      const payload = payloadFrom(i, match[1], segment, tokens[i]);
      if (!payload) return;
      const nested = withDirectory(payload, "ps");
      const inner = options.classifyInner
        ? options.classifyInner(nested, "ps")
        : classifyWindows(nested, { platform: "win32", context: "ps" });
      merge(result, inner);
      return;
    }
    return;
  }

  if (context === "ps" && /\$\(/.test(segment)) {
    result.write = true;
    result.inline = true;
    result.notes.push("PowerShell subexpression cannot be resolved");
    return;
  }

  // `sc` is service control in cmd, Set-Content in PowerShell. In the auto
  // context, a service subcommand keeps it a read; a path-shaped first operand
  // is the PowerShell alias. This check runs before the PowerShell verbs so
  // `sc query` is not mistaken for Set-Content.
  if (name === "sc" && context !== "ps") {
    const first = args.map((arg) => stripQuotes(arg.value)).find((value) => !isFlag(value));
    if (!first || CMD_SC_SUBCOMMANDS.has(first.toLowerCase())) return;
    if (!looksLikePath(first) && args.filter((arg) => !isFlag(arg.value)).length < 2) return;
    classifyWrite(result, "sc", args.map((arg) => arg.value), "ps", state);
    return;
  }

  if (context !== "cmd" && classifyPowerShellCommand(result, name, args, state)) return;

  if (classifyCmdCommand(result, name, args.map((arg) => arg.value), state)) return;
}

/**
 * Classify a Windows command line.
 *
 * @param {string} command
 * @param {{ platform?: string, context?: "auto"|"cmd"|"ps", classifyInner?: (payload: string, context: string) => any } | string} [options]
 */
export function classifyWindows(command, options = {}) {
  const text = stripPosixHeredocs(String(command ?? ""));
  const opts = typeof options === "string" ? { platform: options } : (options ?? {});
  const platform = opts.platform || process.platform;
  const context = opts.context === "cmd" || opts.context === "ps" ? opts.context : "auto";
  const forceWindows = opts.forceWindows ?? platform === "win32";
  const result = empty();
  const state = { dir: opts.dir ?? null, unresolved: false, stack: [] };
  // Once a segment proves the payload is a Windows command, later segments in
  // the same line belong to the same shell (`cd C:\out && del x`).
  // A bare POSIX command must not become a Windows command just because the
  // host is Windows: Git Bash is a first-class shell there. Windows wrappers,
  // drive paths, and known Windows verbs opt in.
  let active = context !== "auto" || forceWindows;

  for (const segment of splitSegments(text)) {
    classifySegment(result, segment, {
      platform,
      context,
      classifyInner: opts.classifyInner,
      state,
      forced: active,
      force: forceWindows,
    });
    if (result.detected) active = true;
    if (result.hardDeny) break;
  }

  result.paths = [...new Set(result.paths.filter(Boolean))];
  return result;
}
