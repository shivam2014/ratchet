// @ts-check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Codex home for the current process (CODEX_HOME wins). */
export function codexHome(home = process.env.HOME || "") {
  return process.env.CODEX_HOME || path.join(home, ".codex");
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
 * Verified against Codex 0.163.
 */
export function hookTrustHash(group, handler) {
  const identity = {
    event_name: "pre_tool_use",
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

export function findRatchetHook(hooksFile) {
  if (!fs.existsSync(hooksFile)) return null;
  const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  const group = (hooks.hooks?.PreToolUse ?? [])[0];
  if (!group) return null;
  const handler = (group.hooks ?? []).find(
    (h) => typeof h?.command === "string" && h.command.includes("adapters/codex/hook.mjs"),
  );
  if (!handler) return null;
  return { group, handler, key: `${hooksFile}:pre_tool_use:0:0` };
}

export function readTrustHash(codexDir) {
  const configFile = path.join(codexDir, "config.toml");
  if (!fs.existsSync(configFile)) return null;
  const config = fs.readFileSync(configFile, "utf8");
  const section = `[hooks.state."${path.join(codexDir, "hooks.json")}:pre_tool_use:0:0"]`;
  const index = config.indexOf(section);
  if (index === -1) return null;
  const end = config.indexOf("\n[", index + section.length);
  const body = config.slice(index, end === -1 ? config.length : end);
  return body.match(/trusted_hash\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

export function writeTrustHash(codexDir, trusted) {
  const configFile = path.join(codexDir, "config.toml");
  let config = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  const section = `[hooks.state."${path.join(codexDir, "hooks.json")}:pre_tool_use:0:0"]`;
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
  fs.writeFileSync(configFile, config);
}

/** Compute and persist the trust entry for the installed Ratchet hook. */
export function installTrust(codexDir) {
  const hooksFile = path.join(codexDir, "hooks.json");
  const found = findRatchetHook(hooksFile);
  if (!found) return { ok: false, reason: `no Ratchet hook in ${hooksFile}` };
  const trusted = hookTrustHash(found.group, found.handler);
  writeTrustHash(codexDir, trusted);
  return { ok: true, trusted, key: found.key };
}
