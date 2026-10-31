// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, readJson, readText, writeJson, writeText } from "./fsx.mjs";
import { which as platformWhich } from "./platform.mjs";
import { installTrust, isRatchetHookCommand } from "./codex-trust.mjs";

export const ORDER = ["pi", "claude", "opencode", "t3", "codex"];

export const LABEL = {
  pi: "pi coding agent",
  claude: "Claude Code",
  opencode: "OpenCode",
  t3: "T3 Code (OpenCode)",
  codex: "Codex CLI",
};

export function which(command, options = {}) {
  return platformWhich(command, options);
}

export function detectHarnesses(home = process.env.HOME || "") {
  const has = (p) => fs.existsSync(path.join(home, p));
  const opencode = Boolean(which("opencode") || has(".config/opencode"));
  return {
    pi: Boolean(which("pi") || has(".pi")),
    claude: Boolean(which("claude") || has(".claude")),
    opencode,
    t3: Boolean(opencode || has(".t3") || process.env.T3_CODE),
    codex: Boolean(which("codex") || has(".codex")),
  };
}

export function manifestPath(root) {
  return path.join(root, ".ratchet", "install.json");
}

export function loadManifest(root) {
  return readJson(manifestPath(root), { version: 1, installed: {} });
}

export function saveManifest(root, manifest) {
  writeJson(manifestPath(root), manifest);
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureDirFor(file) {
  ensureDir(path.dirname(file));
}

function exists(p) {
  return Boolean(fs.lstatSync(p, { throwIfNoEntry: false }));
}

/** Write a file we own. Refuses to clobber a foreign file without --force. */
function ensureOwnedFile(file, content, ctx, marker = "ratchet") {
  const present = exists(file);
  if (present) {
    const old = readText(file, "");
    if (old === content) {
      ctx.actions.push(`unchanged ${file}`);
      return;
    }
    if (!old.includes(marker) && !ctx.force) {
      ctx.actions.push(`skip ${file} (foreign file; --force to replace)`);
      return;
    }
    ctx.actions.push(`update ${file}`);
  } else {
    ctx.actions.push(`create ${file}`);
  }
  if (!ctx.dryRun) {
    ensureDirFor(file);
    writeText(file, content);
  }
}

function ensureSkillLink(skillDir, target, ctx) {
  ensureDir(path.dirname(target));
  if (exists(target)) {
    if (isSymlink(target) && fs.readlinkSync(target) === skillDir) {
      ctx.actions.push(`unchanged ${target}`);
      return;
    }
    if (!ctx.force) {
      ctx.actions.push(`skip ${target} (exists; --force to replace)`);
      return;
    }
    ctx.actions.push(`replace ${target}`);
    if (!ctx.dryRun) fs.rmSync(target, { recursive: true, force: true });
  } else {
    ctx.actions.push(`link ${target}`);
  }
  if (!ctx.dryRun) fs.symlinkSync(skillDir, target, "dir");
}

function projectOrUser(ctx, userPath, projectPath) {
  return ctx.scope === "user" ? userPath : path.join(ctx.root, projectPath);
}

function installPi(ctx) {
  const adapter = path.join(ctx.repoRoot, "adapters", "pi", "ratchet.ts");
  const dest = projectOrUser(ctx, path.join(ctx.home, ".pi/agent/extensions/ratchet.ts"), ".pi/extensions/ratchet.ts");
  ensureOwnedFile(dest, readText(adapter, ""), ctx);
  const skill = projectOrUser(ctx, path.join(ctx.home, ".pi/agent/skills/ratchet-mode"), ".pi/skills/ratchet-mode");
  ensureSkillLink(path.join(ctx.repoRoot, "skills", "ratchet-mode"), skill, ctx);
  ctx.warnings.push("pi: restart the session or run /reload after installing the extension.");
  return [dest, skill];
}

export const CLAUDE_HOOK_EVENTS = [
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|Bash" },
  { event: "PostToolUse", matcher: "Write|Edit|MultiEdit|Bash" },
  { event: "Stop", timeout: 600 },
];

/**
 * One Ratchet handler per event, each in its own group. Codex's trust hash
 * covers exactly one handler, so mixing Ratchet into a shared group would make
 * the hash cover another project's hook too.
 */
export const CODEX_HOOK_EVENTS = [
  { event: "UserPromptSubmit", timeout: 30, statusMessage: "ratchet: injecting contract" },
  {
    event: "PreToolUse",
    matcher: "Bash|apply_patch|Edit|Write",
    timeout: 30,
    statusMessage: "ratchet: checking contract",
  },
  {
    event: "PostToolUse",
    matcher: "Bash|apply_patch|Edit|Write",
    timeout: 30,
    statusMessage: "ratchet: recording result",
  },
  { event: "Stop", timeout: 600, statusMessage: "ratchet: verifying" },
];

function isRatchetClaudeHook(command) {
  return (
    typeof command === "string" &&
    command.includes("ratchet") &&
    (command.includes("hook.mjs") || command.includes("guard"))
  );
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeEntry(template, spec, command, extra) {
  const entry = { ...template };
  if (spec.matcher) entry.matcher = spec.matcher;
  else delete entry.matcher;
  const handler = { type: "command", command };
  if (spec.timeout) handler.timeout = spec.timeout;
  entry.hooks = [handler, ...extra];
  return entry;
}

function mergeClaudeEvent(list, spec, command) {
  const out = [];
  let placed = false;
  for (const entry of list) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
      out.push(entry);
      continue;
    }
    const ours = entry.hooks.filter((handler) => isRatchetClaudeHook(handler?.command));
    const theirs = entry.hooks.filter((handler) => !isRatchetClaudeHook(handler?.command));
    if (ours.length && !placed) {
      out.push(claudeEntry(entry, spec, command, theirs));
      placed = true;
      continue;
    }
    if (theirs.length) out.push({ ...entry, hooks: theirs });
  }
  if (!placed) out.push(claudeEntry({}, spec, command, []));
  return out;
}

/** Exactly one Ratchet handler per lifecycle event; unrelated handlers survive. */
export function mergeClaudeHooks(settings, command) {
  const out = isPlainObject(settings) ? structuredClone(settings) : {};
  if (out.hooks === undefined || out.hooks === null) out.hooks = {};
  else if (!isPlainObject(out.hooks)) throw new Error("hooks is not an object");
  for (const spec of CLAUDE_HOOK_EVENTS) {
    const current = out.hooks[spec.event];
    if (current !== undefined && current !== null && !Array.isArray(current)) {
      throw new Error(`hooks.${spec.event} is not an array`);
    }
    out.hooks[spec.event] = mergeClaudeEvent(Array.isArray(current) ? current : [], spec, command);
  }
  return out;
}

function ratchetCommand(ctx) {
  return `${process.execPath} ${path.join(ctx.repoRoot, "adapters", "claude", "hook.mjs")}`;
}

function claudeConfigDir(ctx) {
  return process.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, ".claude");
}

function installClaude(ctx) {
  const file = projectOrUser(ctx, path.join(claudeConfigDir(ctx), "settings.json"), ".claude/settings.json");
  const raw = readText(file, "");
  let parsed = {};
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${file} is not valid JSON. Fix it or move it before installing.`);
    }
  }
  const command = ratchetCommand(ctx);
  const settings = mergeClaudeHooks(parsed, command);
  const changed = JSON.stringify(settings) !== JSON.stringify(parsed);
  if (!changed) {
    ctx.actions.push(`unchanged ${file}`);
  } else {
    ctx.actions.push(`${raw.trim() ? "update" : "create"} ${file}`);
    if (!ctx.dryRun) {
      ensureDirFor(file);
      if (raw.trim()) {
        const backup = `${file}.ratchet.bak.${Date.now()}`;
        writeText(backup, raw);
        ctx.actions.push(`backup ${backup}`);
      }
      writeJson(file, settings);
    }
  }
  const skill = projectOrUser(ctx, path.join(claudeConfigDir(ctx), "skills/ratchet-mode"), ".claude/skills/ratchet-mode");
  ensureSkillLink(path.join(ctx.repoRoot, "skills", "ratchet-mode"), skill, ctx);
  return [file, skill];
}

function opencodeAdapterFile(ctx) {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const major = Number(text.match(/(\d+)\./)?.[1] ?? 2);
  return path.join(ctx.repoRoot, "adapters", "opencode", major >= 2 ? "ratchet.js" : "ratchet-v1.js");
}

function installOpencode(ctx, displayName = "OpenCode") {
  const adapter = opencodeAdapterFile(ctx);
  const dest = projectOrUser(
    ctx,
    path.join(ctx.home, ".config/opencode/plugins/ratchet.js"),
    ".opencode/plugins/ratchet.js",
  );
  ensureOwnedFile(dest, readText(adapter, ""), ctx);
  const skill = projectOrUser(ctx, path.join(ctx.home, ".agents/skills/ratchet-mode"), ".agents/skills/ratchet-mode");
  ensureSkillLink(path.join(ctx.repoRoot, "skills", "ratchet-mode"), skill, ctx);
  ctx.warnings.push(`${displayName}: restart the app after installing the plugin.`);
  return [dest, skill];
}

function codexHome(ctx) {
  return process.env.CODEX_HOME || path.join(ctx.home, ".codex");
}

function codexEntry(spec, command) {
  const entry = {};
  if (spec.matcher) entry.matcher = spec.matcher;
  entry.hooks = [
    {
      type: "command",
      command,
      timeout: spec.timeout,
      statusMessage: spec.statusMessage,
    },
  ];
  return entry;
}

function mergeCodexEvent(list, spec, command) {
  const out = [];
  let placed = false;
  for (const entry of list) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
      out.push(entry);
      continue;
    }
    const ours = entry.hooks.filter((handler) => isRatchetHookCommand(handler?.command));
    const theirs = entry.hooks.filter((handler) => !isRatchetHookCommand(handler?.command));
    if (ours.length && !placed) {
      out.push(codexEntry(spec, command));
      placed = true;
    }
    if (theirs.length) out.push(theirs.length === entry.hooks.length ? entry : { ...entry, hooks: theirs });
  }
  if (!placed) out.push(codexEntry(spec, command));
  return out;
}

/** Exactly one Ratchet handler per lifecycle event; unrelated groups survive. */
export function mergeCodexHooks(hooks, command) {
  const out = isPlainObject(hooks) ? structuredClone(hooks) : {};
  for (const spec of CODEX_HOOK_EVENTS) {
    const current = out[spec.event];
    if (current !== undefined && current !== null && !Array.isArray(current)) {
      throw new Error(`hooks.${spec.event} is not an array`);
    }
    out[spec.event] = mergeCodexEvent(Array.isArray(current) ? current : [], spec, command);
  }
  return out;
}

export function removeCodexHooks(hooks) {
  let changed = false;
  for (const spec of CODEX_HOOK_EVENTS) {
    const list = hooks?.[spec.event];
    if (!Array.isArray(list)) continue;
    const next = [];
    let removed = false;
    for (const entry of list) {
      if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
        next.push(entry);
        continue;
      }
      const kept = entry.hooks.filter((handler) => !isRatchetHookCommand(handler?.command));
      if (kept.length === entry.hooks.length) {
        next.push(entry);
        continue;
      }
      removed = true;
      if (kept.length) next.push({ ...entry, hooks: kept });
    }
    if (!removed) continue;
    hooks[spec.event] = next;
    changed = true;
  }
  return changed;
}

function installCodex(ctx) {
  const file = projectOrUser(ctx, path.join(codexHome(ctx), "hooks.json"), ".codex/hooks.json");
  const raw = readText(file, "");
  let parsed = { hooks: {} };
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${file} is not valid JSON. Fix it or move it before installing.`);
    }
  }
  const command = `${process.execPath} ${path.join(ctx.repoRoot, "adapters", "codex", "hook.mjs")}`;
  const settings = { ...parsed, hooks: mergeCodexHooks(parsed.hooks ?? {}, command) };
  const changed = JSON.stringify(settings) !== JSON.stringify(parsed);

  if (!changed) {
    ctx.actions.push(`unchanged ${file}`);
  } else {
    ctx.actions.push(`${raw.trim() ? "update" : "create"} ${file}`);
    if (!ctx.dryRun) {
      ensureDirFor(file);
      if (raw.trim()) {
        const backup = `${file}.ratchet.bak.${Date.now()}`;
        writeText(backup, raw);
        ctx.actions.push(`backup ${backup}`);
      }
      writeJson(file, settings);
    }
  }

  const skill = projectOrUser(ctx, path.join(ctx.home, ".agents/skills/ratchet-mode"), ".agents/skills/ratchet-mode");
  ensureSkillLink(path.join(ctx.repoRoot, "skills", "ratchet-mode"), skill, ctx);

  if (!ctx.dryRun) {
    try {
      // Project hooks still take their trust state from the user's Codex home.
      const trust = installTrust(codexHome(ctx), file);
      if (trust.ok) ctx.actions.push(`trust ${trust.entries.length} codex hooks`);
      else ctx.warnings.push(`Codex trust: ${trust.reason}`);
    } catch (error) {
      ctx.warnings.push(`Codex trust failed: ${error.message}`);
    }
    const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
    const text = `${version.stdout || ""}${version.stderr || ""}`.trim();
    const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match && !(match[1] === "0" && match[2] === "163")) {
      ctx.warnings.push(`Codex ${text} is not the version the trust hash was verified against (0.163); run /hooks if the hook is skipped`);
    }
  }

  ctx.warnings.push(
    "Codex: trust is written automatically for all four lifecycle hooks (hash verified on 0.163 for PreToolUse). If a Codex upgrade changes the trust format, run /hooks in the TUI. The hook is a no-op outside a repo with .ratchet/config.json or .ratchet/current.",
  );
  return [file, skill];
}

export function installHarness(name, ctx) {
  switch (name) {
    case "pi":
      return installPi(ctx);
    case "claude":
      return installClaude(ctx);
    case "opencode":
      return installOpencode(ctx);
    case "t3":
      return installOpencode(ctx, "T3 Code");
    case "codex":
      return installCodex(ctx);
    default:
      throw new Error(`unknown harness: ${name}`);
  }
}

function removeIfOurs(file, marker, ctx) {
  if (!exists(file)) return;
  if (isSymlink(file)) return;
  const text = readText(file, "");
  if (!text.includes(marker)) {
    ctx.actions.push(`left ${file} (not ours)`);
    return;
  }
  ctx.actions.push(`remove ${file}`);
  if (!ctx.dryRun) fs.rmSync(file, { force: true });
}

function removeClaudeHooks(parsed) {
  let changed = false;
  for (const spec of CLAUDE_HOOK_EVENTS) {
    const list = parsed?.hooks?.[spec.event];
    if (!Array.isArray(list)) continue;
    const next = [];
    let removed = false;
    for (const entry of list) {
      if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
        next.push(entry);
        continue;
      }
      const hooks = entry.hooks.filter((handler) => !isRatchetClaudeHook(handler?.command));
      if (hooks.length === entry.hooks.length) {
        next.push(entry);
        continue;
      }
      removed = true;
      if (hooks.length) next.push({ ...entry, hooks });
    }
    if (!removed) continue;
    parsed.hooks[spec.event] = next;
    changed = true;
  }
  return changed;
}

function removeClaudeHook(ctx) {
  const file = projectOrUser(ctx, path.join(claudeConfigDir(ctx), "settings.json"), ".claude/settings.json");
  if (!exists(file)) return;
  const raw = readText(file, "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.warnings.push(`${file} is not valid JSON; leaving it alone`);
    return;
  }
  if (!removeClaudeHooks(parsed)) return;
  ctx.actions.push(`update ${file} (remove ratchet hooks)`);
  if (!ctx.dryRun) {
    writeText(`${file}.ratchet.bak.${Date.now()}`, raw);
    writeJson(file, parsed);
  }
}

function removeCodexHook(ctx) {
  const file = projectOrUser(ctx, path.join(codexHome(ctx), "hooks.json"), ".codex/hooks.json");
  if (!exists(file)) return;
  const raw = readText(file, "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.warnings.push(`${file} is not valid JSON; leaving it alone`);
    return;
  }
  if (!parsed?.hooks || !removeCodexHooks(parsed.hooks)) return;
  ctx.actions.push(`update ${file} (remove ratchet hooks)`);
  if (!ctx.dryRun) {
    writeText(`${file}.ratchet.bak.${Date.now()}`, raw);
    writeJson(file, parsed);
  }
}

export function uninstallHarness(name, ctx, record, protect = new Set()) {
  for (const p of record?.paths ?? []) {
    if (protect.has(p)) {
      ctx.actions.push(`keep ${p} (shared with another harness)`);
      continue;
    }
    if (p.endsWith("ratchet-mode") && isSymlink(p)) {
      ctx.actions.push(`unlink ${p}`);
      if (!ctx.dryRun) fs.rmSync(p, { force: true });
    } else if (p.endsWith("ratchet.js") || p.endsWith("ratchet.ts")) {
      removeIfOurs(p, "ratchet", ctx);
    }
  }
  if (name === "claude") removeClaudeHook(ctx);
  if (name === "codex") removeCodexHook(ctx);
}
