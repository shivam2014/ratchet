// @ts-check
import fs from "node:fs";
import path from "node:path";
import { matchesAny } from "./glob.mjs";
import { toPosix } from "./fsx.mjs";
import { pathIsInside } from "./platform.mjs";

/**
 * A minimal import-boundary check. It answers one question: does a file import
 * a file the config says it must not? It does not judge layering, naming, or
 * design; it only reports edges that the repo declared forbidden.
 *
 *   {
 *     "architecture": {
 *       "forbidden": [{ "from": "src/ui/**", "to": "src/core/**", "reason": "..." }],
 *       "cycles": true
 *     }
 *   }
 */

const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx"];
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, ".json"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".ratchet",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
]);

const IMPORT_FROM = /(?<![\w$.])import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
const EXPORT_FROM =
  /(?<![\w$.])export\s+(?:type\s+)?(?:\*\s*(?:as\s+\w+\s*)?|\{[^}]*\})\s+from\s*["']([^"']+)["']/g;
const REQUIRE_CALL = /(?<![\w$.])require\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g;

function isSource(file) {
  return SOURCE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

/** Deterministic repo walk: sorted directories, skipped build and runtime state. */
export function sourceFiles(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !isSource(entry.name)) continue;
      files.push(toPosix(path.relative(root, path.join(dir, entry.name))));
    }
  };
  visit(root);
  return files;
}

/** Import/require/export specifiers in one source file, in source order. */
export function importSpecifiers(text) {
  const found = new Set();
  for (const pattern of [IMPORT_FROM, EXPORT_FROM, REQUIRE_CALL, DYNAMIC_IMPORT]) {
    for (const match of String(text || "").matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/**
 * Resolve a relative specifier to a repo-relative file. Bare package names are
 * not resolved: this check is about files the repo owns. TypeScript's `.js`
 * specifier for a `.ts` file is accepted.
 */
export function resolveImport(root, importer, specifier) {
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return null;
  const base = path.resolve(root, path.dirname(importer), specifier);
  const ext = path.extname(base);
  const candidates = [];
  if (ext) candidates.push(base);
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(base + extension);
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const stem = base.slice(0, -ext.length);
    for (const extension of [".ts", ".tsx", ".js", ".mjs", ".cjs"]) candidates.push(stem + extension);
  }

  for (const candidate of candidates) {
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!pathIsInside(path.resolve(root), path.resolve(candidate))) return null;
    return toPosix(path.relative(root, candidate));
  }
  return null;
}

function canonicalCycle(cycle) {
  let best = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[best]) best = i;
  }
  return [...cycle.slice(best), ...cycle.slice(0, best)];
}

/** One violation per distinct directed cycle, deterministic order. */
function findCycles(edges, files) {
  const found = new Map();
  const color = new Map();
  const stack = [];

  const visit = (file) => {
    color.set(file, 1);
    stack.push(file);
    for (const next of [...(edges.get(file) ?? [])].sort()) {
      if (!files.has(next)) continue;
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const cycle = canonicalCycle(stack.slice(stack.indexOf(next)));
        const key = cycle.join("\0");
        if (!found.has(key)) found.set(key, cycle);
      } else if (state === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(file, 2);
  };

  for (const file of [...files].sort()) {
    if ((color.get(file) ?? 0) === 0) visit(file);
  }
  return [...found.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]);
}

/**
 * Run the configured boundary rules. With no `architecture` config this is a
 * no-op. Shape: `{ok, violations: [{rule, from, to, reason}], configured, files}`.
 */
export function architectureCheck(root, config = {}) {
  const architecture =
    config && typeof config === "object" && config.architecture && typeof config.architecture === "object"
      ? config.architecture
      : null;
  if (!architecture) {
    return { ok: true, configured: false, files: 0, violations: [] };
  }

  const forbidden = (Array.isArray(architecture.forbidden) ? architecture.forbidden : []).filter(
    (rule) =>
      rule &&
      typeof rule === "object" &&
      typeof rule.from === "string" &&
      rule.from.trim() &&
      typeof rule.to === "string" &&
      rule.to.trim(),
  );
  const checkCycles = architecture.cycles === true;
  const files = sourceFiles(root);
  if (!forbidden.length && !checkCycles) {
    return { ok: true, configured: true, files: files.length, violations: [] };
  }

  const fileSet = new Set(files);
  /** @type {Map<string, string[]>} */
  const edges = new Map();
  const violations = [];
  let imports = 0;

  for (const importer of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, importer), "utf8");
    } catch {
      continue;
    }
    const targets = new Set();
    for (const specifier of importSpecifiers(text)) {
      const target = resolveImport(root, importer, specifier);
      if (!target) continue;
      imports += 1;
      targets.add(target);
      for (const rule of forbidden) {
        if (!matchesAny(importer, [rule.from]) || !matchesAny(target, [rule.to])) continue;
        violations.push({
          rule: "forbidden",
          from: importer,
          to: target,
          reason: String(rule.reason || `imports from ${rule.from} to ${rule.to} are forbidden`),
        });
      }
    }
    edges.set(importer, [...targets].sort());
  }

  if (checkCycles) {
    for (const cycle of findCycles(edges, fileSet)) {
      const next = cycle.length > 1 ? cycle[1] : cycle[0];
      violations.push({
        rule: "cycles",
        from: cycle[0],
        to: next,
        reason: `import cycle: ${[...cycle, cycle[0]].join(" -> ")}`,
      });
    }
  }

  violations.sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.reason.localeCompare(b.reason),
  );

  return {
    ok: violations.length === 0,
    configured: true,
    files: files.length,
    imports,
    violations,
  };
}
