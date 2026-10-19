#!/usr/bin/env node
/**
 * Trust the Ratchet Codex hook for the current CODEX_HOME.
 *
 * Codex records trust as a SHA-256 over a normalized identity: the event name,
 * the matcher, and one normalized `command` handler, serialized to TOML,
 * converted to JSON, with object keys sorted. This reproduces that hash for the
 * installed hooks.json and writes it to the matching `[hooks.state]` entry in
 * config.toml.
 *
 * Verified against Codex 0.163. If a later Codex release changes the identity
 * shape, run /hooks in the TUI instead; the hash will simply not match and the
 * hook stays untrusted rather than silently allowing anything.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const hooksFile = path.join(home, "hooks.json");
const configFile = path.join(home, "config.toml");

const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
const group = (hooks.hooks?.PreToolUse ?? [])[0];
if (!group) {
  console.error(`no PreToolUse group in ${hooksFile}`);
  process.exit(1);
}
const handler = (group.hooks ?? []).find(
  (h) => typeof h?.command === "string" && h.command.includes("adapters/codex/hook.mjs"),
);
if (!handler) {
  console.error(`no Ratchet hook in ${hooksFile}`);
  process.exit(1);
}

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
const dropNull = (value) => {
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
};
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
};
const serialized = JSON.stringify(sortKeys(dropNull(identity)));
const trusted = "sha256:" + crypto.createHash("sha256").update(serialized).digest("hex");

let config = fs.readFileSync(configFile, "utf8");
const key = `${hooksFile}:pre_tool_use:0:0`;
const section = `[hooks.state."${key}"]`;
const index = config.indexOf(section);
const entry = `trusted_hash = "${trusted}"`;
if (index === -1) {
  config = `${config.trimEnd()}\n\n${section}\ntrusted_hash = "${trusted}"\n`;
} else {
  const sectionEnd = config.indexOf("\n[", index + section.length);
  const end = sectionEnd === -1 ? config.length : sectionEnd;
  const body = config.slice(index, end);
  const updated = /trusted_hash = "[^"]*"/.test(body)
    ? body.replace(/trusted_hash = "[^"]*"/, entry)
    : `${body.trimEnd()}\n${entry}\n`;
  config = config.slice(0, index) + updated + config.slice(end);
}
fs.writeFileSync(configFile, config);
console.log(`trusted ${key}`);
console.log(trusted);
