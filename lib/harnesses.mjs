// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, readJson, readText, writeJson, writeText } from "./fsx.mjs";

export const ORDER = ["pi", "claude", "opencode", "t3", "codex"];

export const LABEL = {
  pi: "pi coding agent",
  claude: "Claude Code",
  opencode: "OpenCode",
  t3: "T3 Code (OpenCode)",
  codex: "Codex CLI",
};

export function which(command) {
  const r = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
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

function mergeClaudeHook(settings, command) {
  const out = settings && typeof settings === "object" && !Array.isArray(settings) ? structuredClone(settings) : {};
  out.hooks ??= {};
  out.hooks.PreToolUse ??= [];
  if (!Array.isArray(out.hooks.PreToolUse)) throw new Error("hooks.PreToolUse is not an array");
  const already = out.hooks.PreToolUse.some((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes("ratchet guard")),
  );
  if (!already) {
    out.hooks.PreToolUse.push({
      matcher: "Write|Edit|MultiEdit|Bash",
      hooks: [{ type: "command", command }],
    });
  }
  return { settings: out, changed: !already };
}

function installClaude(ctx) {
  const file = projectOrUser(ctx, path.join(ctx.home, ".claude/settings.json"), ".claude/settings.json");
  const raw = readText(file, "");
  let parsed = {};
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${file} is not valid JSON. Fix it or move it before installing.`);
    }
  }
  const { settings, changed } = mergeClaudeHook(parsed, "ratchet guard --format claude");
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
  const skill = projectOrUser(ctx, path.join(ctx.home, ".claude/skills/ratchet-mode"), ".claude/skills/ratchet-mode");
  ensureSkillLink(path.join(ctx.repoRoot, "skills", "ratchet-mode"), skill, ctx);
  return [file, skill];
}

function installOpencode(ctx, displayName = "OpenCode") {
  const adapter = path.join(ctx.repoRoot, "adapters", "opencode", "ratchet.js");
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

function installCodex(ctx) {
  const skill = projectOrUser(ctx, path.join(ctx.home, ".agents/skills/ratchet-mode"), ".agents/skills/ratchet-mode");
  ensureSkillLink(path.join(ctx.repoRoot, "skills", "ratchet-mode"), skill, ctx);
  ctx.warnings.push("Codex: no portable pre-tool hook. Ratchet is advisory here; use the sandbox and a required CI check.");
  return [skill];
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

function removeClaudeHook(ctx) {
  const file = projectOrUser(ctx, path.join(ctx.home, ".claude/settings.json"), ".claude/settings.json");
  if (!exists(file)) return;
  const raw = readText(file, "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.warnings.push(`${file} is not valid JSON; leaving it alone`);
    return;
  }
  const list = parsed?.hooks?.PreToolUse;
  if (!Array.isArray(list)) return;
  const next = list.filter(
    (entry) => !(Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes("ratchet guard"))),
  );
  if (next.length === list.length) return;
  parsed.hooks.PreToolUse = next;
  ctx.actions.push(`update ${file} (remove ratchet hook)`);
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
}
