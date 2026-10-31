// @ts-check
import fs from "node:fs";
import path from "node:path";
import { isWindows, pathIsInside } from "./platform.mjs";

/** Walk up from start until a .ratchet or .git directory is found. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet"))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function stateDir(root) {
  return path.join(root, ".ratchet");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Atomic write: a crash never leaves a half-written contract. */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function readText(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function timestampId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function slug(text, max = 40) {
  return String(text || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "task";
}

export function toPosix(p) {
  return String(p).replaceAll("\\", "/");
}

/** True when child is inside root (or equal to it). Windows compares case-insensitively. */
export function isInside(root, child, platform = process.platform) {
  return pathIsInside(root, child, platform);
}

/** Repository-relative POSIX path, or the absolute path when outside root. */
export function repoRel(root, p) {
  let value = String(p || "");
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  if (value.startsWith("~/") || (isWindows() && value.startsWith("~\\"))) {
    value = path.join(home, value.slice(2));
  }
  const abs = path.isAbsolute(value) ? value : path.resolve(root, value);
  if (!isInside(root, abs)) return toPosix(abs);
  return toPosix(path.relative(root, abs));
}
