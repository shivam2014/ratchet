// @ts-check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Codex hook event names and the snake_case form used in trust keys. */
export const CODEX_TRUST_EVENTS = {
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  Stop: "stop",
};

/** Codex home for the current process (CODEX_HOME wins). */
export function codexHome(home = process.env.HOME || process.env.USERPROFILE || "") {
  return process.env.CODEX_HOME || path.join(home, ".codex");
}

export function isRatchetHookCommand(command) {
  return typeof command === "string" && /adapters[\\/]codex[\\/]hook\.mjs/.test(command);
}

export function hookTrustKey(hooksFile, event, groupIndex, handlerIndex) {
  const eventName = CODEX_TRUST_EVENTS[event];
  if (!eventName) throw new Error(`unknown Codex hook event: ${event}`);
  if (!Number.isInteger(groupIndex) || !Number.isInteger(handlerIndex)) {
    throw new Error("hook trust key needs integer group and handler indexes");
  }
  return `${hooksFile}:${eventName}:${groupIndex}:${handlerIndex}`;
}

function dropNull(value) {
  if (Array.isArray(value)) return value.map(dropNull);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === null || val === undefined) continue;
      out[key] = dropNull(val);
    }
    return out;
  }
  return value;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/**
 * Reproduce Codex's hook trust hash: event name + matcher + one normalized
 * command handler, serialized to TOML -> JSON with sorted keys -> SHA-256.
 * Verified against Codex 0.163 for pre_tool_use.
 */
export function hookTrustHash(group, handler, event = "PreToolUse") {
  const eventName = CODEX_TRUST_EVENTS[event];
  if (!eventName) throw new Error(`unknown Codex hook event: ${event}`);
  const identity = {
    event_name: eventName,
    matcher: group.matcher ?? null,
    hooks: [
      {
        type: "command",
        command: handler.command,
        timeout: handler.timeout ?? 600,
        async: handler.async === true,
        statusMessage: handler.statusMessage ?? null,
        additionalContextLimit: handler.additionalContextLimit ?? null,
      },
    ],
  };
  const serialized = JSON.stringify(sortKeys(dropNull(identity)));
  return "sha256:" + crypto.createHash("sha256").update(serialized).digest("hex");
}

/** Every Ratchet handler in the file, with its real group/handler index. */
export function findRatchetHooks(hooksFile) {
  if (!fs.existsSync(hooksFile)) return [];
  const file = fs.realpathSync(hooksFile);
  const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
  const found = [];
  for (const event of Object.keys(CODEX_TRUST_EVENTS)) {
    const groups = hooks.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!Array.isArray(group?.hooks)) return;
      group.hooks.forEach((handler, handlerIndex) => {
        if (!isRatchetHookCommand(handler?.command)) return;
        found.push({
          event,
          group,
          handler,
          groupIndex,
          handlerIndex,
          key: hookTrustKey(file, event, groupIndex, handlerIndex),
        });
      });
    });
  }
  return found;
}

export function readTrustHash(codexDir, key) {
  const configFile = path.join(codexDir, "config.toml");
  if (!fs.existsSync(configFile)) return null;
  const config = fs.readFileSync(configFile, "utf8");
  const section = `[hooks.state."${key}"]`;
  const index = config.indexOf(section);
  if (index === -1) return null;
  const end = config.indexOf("\n[", index + section.length);
  const body = config.slice(index, end === -1 ? config.length : end);
  return body.match(/trusted_hash\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

export function writeTrustHash(codexDir, key, trusted) {
  const configFile = path.join(codexDir, "config.toml");
  let config = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  const section = `[hooks.state."${key}"]`;
  const entry = `trusted_hash = "${trusted}"`;
  const index = config.indexOf(section);
  if (index === -1) {
    config = `${config.trimEnd()}\n\n${section}\n${entry}\n`;
  } else {
    const end = config.indexOf("\n[", index + section.length);
    const body = config.slice(index, end === -1 ? config.length : end);
    const updated = /trusted_hash\s*=\s*"[^"]*"/.test(body)
      ? body.replace(/trusted_hash\s*=\s*"[^"]*"/, entry)
      : `${body.trimEnd()}\n${entry}\n`;
    config = config.slice(0, index) + updated + (end === -1 ? "" : config.slice(end));
  }
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(configFile, config);
}

/** Compute and persist one trust entry per installed Ratchet handler. */
export function installTrust(codexDir, hooksFile = path.join(codexDir, "hooks.json")) {
  const found = findRatchetHooks(hooksFile);
  if (!found.length) return { ok: false, reason: `no Ratchet hook in ${hooksFile}` };

  const entries = found.map((hook) => ({
    event: hook.event,
    key: hook.key,
    trusted: hookTrustHash(hook.group, hook.handler, hook.event),
  }));
  for (const entry of entries) writeTrustHash(codexDir, entry.key, entry.trusted);
  return { ok: true, entries, key: entries[0].key, trusted: entries[0].trusted };
}
