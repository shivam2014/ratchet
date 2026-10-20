// @ts-check
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInside, readJson, repoRel } from "./fsx.mjs";

const CHECK_EXTENSIONS = new Set([
  ".mjs", ".js", ".cjs", ".ts", ".tsx", ".sh", ".py", ".rb", ".go", ".rs", ".bend",
]);

const RUNNER_TOKENS = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun"]);

const CONFIG_FILE = path.join(".ratchet", "config.json");
const PACKAGE_FILE = "package.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

/** Key order in a hash must not depend on the writer's key order. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function commandTokens(command) {
  return String(command ?? "")
    .split(/[\s;&|()<>]+/)
    .map((token) => token.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

function checkFileFor(root, token) {
  if (token.startsWith("-")) return null;
  if (RUNNER_TOKENS.has(token)) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return null;
  if (!CHECK_EXTENSIONS.has(path.extname(token).toLowerCase())) return null;

  const abs = path.resolve(root, token);
  if (!isInside(root, abs)) return null;
  let stat;
  try {
    stat = fs.statSync(abs, { throwIfNoEntry: false });
  } catch {
    return null;
  }
  if (!stat?.isFile()) return null;
  return repoRel(root, abs);
}

function commandsOf(verify) {
  const list = Array.isArray(verify) ? verify : [];
  return list.map((entry) => (typeof entry === "string" ? entry : entry?.cmd)).filter(Boolean);
}

/** A stable fingerprint of everything that decides whether a verify command passes. */
export function computeCheckSurface(root, verify = []) {
  const configFile = path.join(root, CONFIG_FILE);
  const config = fs.existsSync(configFile) ? hashFile(configFile) : null;

  const pkg = readJson(path.join(root, PACKAGE_FILE), null);
  const scripts =
    pkg?.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
      ? sha256(stableJson(pkg.scripts))
      : null;

  const found = new Map();
  for (const command of commandsOf(verify)) {
    for (const token of commandTokens(command)) {
      const file = checkFileFor(root, token);
      if (file) found.set(file, hashFile(path.join(root, file)));
    }
  }
  const files = {};
  for (const file of [...found.keys()].sort()) files[file] = found.get(file);

  return { config, scripts, verify: sha256(stableJson(commandsOf(verify))), files };
}

export function lockCheckSurface(root, verify = []) {
  const surface = computeCheckSurface(root, verify);
  return { ...surface, sha256: sha256(stableJson(surface)) };
}

function surfaceOf(locked) {
  const value = locked && typeof locked === "object" ? locked : {};
  const files = value.files && typeof value.files === "object" ? value.files : {};
  return {
    config: value.config ?? null,
    scripts: value.scripts ?? null,
    verify: value.verify ?? null,
    files,
  };
}

function fieldChange(label, before, after) {
  if (before === after) return [];
  if (before && after) return [`${label} changed`];
  return [before ? `${label} removed` : `${label} added`];
}

/** Human-readable differences, locked against current. Empty means untouched. */
export function diffCheckSurface(locked, current) {
  const before = surfaceOf(locked);
  const after = surfaceOf(current);
  const changes = [
    ...fieldChange("config", before.config, after.config),
    ...fieldChange("package scripts", before.scripts, after.scripts),
    ...fieldChange("verify commands", before.verify, after.verify),
  ];

  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  for (const file of paths) {
    const was = before.files[file];
    const now = after.files[file];
    if (was === now) continue;
    if (was && now) changes.push(`changed check file: ${file}`);
    else if (was) changes.push(`removed check file: ${file}`);
    // Added files do not invalidate a lock. Generated artifacts such as a Bend
    // proof do not exist when the contract starts, and a new file cannot
    // retroactively weaken a check that was already locked.
  }
  return changes;
}
