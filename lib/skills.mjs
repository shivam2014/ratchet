// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRel, toPosix } from "./fsx.mjs";

export const DEFAULT_SKILL_ROOTS = [".agents/skills", "~/.agents/skills"];

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Absolute skill roots that exist, in lookup order. The first root wins on a name collision. */
export function skillRoots(root, config) {
  const configured = config?.auto?.skillRoots;
  const entries =
    Array.isArray(configured) && configured.length
      ? configured
      : typeof configured === "string" && configured.trim()
        ? [configured]
        : DEFAULT_SKILL_ROOTS;
  const seen = new Set();
  const roots = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const abs = path.resolve(root, expandHome(entry.trim()));
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fs.statSync(abs).isDirectory()) roots.push(abs);
    } catch {
      // A missing root is normal: the repo or the user may never have installed skills.
    }
  }
  return roots;
}

/** Shorter, stable form for route metadata: repo-relative, `~`-relative, else absolute. */
function displayPath(root, file) {
  const rel = repoRel(root, file);
  const home = toPosix(os.homedir());
  if (rel.startsWith(home + "/")) return "~" + rel.slice(home.length);
  return rel;
}

function frontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  return end < 0 ? null : lines.slice(1, end);
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n");
  }
  return v;
}

function splitInline(value) {
  const items = [];
  let current = "";
  let quote = "";
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map(unquote).filter(Boolean);
}

function parseScalar(rest, lines, start, indent) {
  const inline = rest.trim();
  let index = start;

  if (/^[>|][+-]?$/.test(inline)) {
    const folded = inline.startsWith(">");
    const parts = [];
    for (; index < lines.length; index++) {
      const line = lines[index];
      if (line.trim() && indentOf(line) <= indent) break;
      parts.push(line.trim());
    }
    while (parts.length && !parts[0]) parts.shift();
    while (parts.length && !parts[parts.length - 1]) parts.pop();
    return { value: parts.join(folded ? " " : "\n").trim(), next: index };
  }

  if (inline) {
    if (inline.startsWith("'") || inline.startsWith('"')) return { value: unquote(inline), next: index };
    const parts = [inline];
    for (; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim() || indentOf(line) <= indent) break;
      if (/^\s*-\s/.test(line)) break;
      parts.push(line.trim());
    }
    return { value: parts.join(" "), next: index };
  }

  const parts = [];
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || indentOf(line) <= indent) break;
    if (/^\s*[A-Za-z0-9_.-]+:\s*/.test(line)) break;
    parts.push(line.trim());
  }
  return { value: parts.join(" "), next: index };
}

function parseArray(rest, lines, start, indent) {
  const inline = rest.trim();
  if (inline.startsWith("[")) {
    const close = inline.lastIndexOf("]");
    return { value: splitInline(close > 0 ? inline.slice(1, close) : inline.slice(1)), next: start };
  }
  if (inline) return { value: [unquote(inline)], next: start };

  const values = [];
  let index = start;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (indentOf(line) <= indent) break;
    const item = line.match(/^\s*-\s*(.*)$/);
    if (!item) break;
    values.push(unquote(item[1]));
  }
  return { value: values.filter(Boolean), next: index };
}

function parseRouting(rest, lines, start, indent) {
  const routing = { keywords: [], examples: [] };
  if (rest.trim()) return { routing, next: start };

  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (indentOf(line) <= indent) break;
    const entry = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!entry) {
      index++;
      continue;
    }
    const key = entry[1];
    if (key === "keywords" || key === "examples") {
      const parsed = parseArray(entry[2], lines, index + 1, indentOf(line));
      routing[key] = parsed.value;
      index = parsed.next;
      continue;
    }
    index++;
  }
  return { routing, next: index };
}

function parseSkillText(text) {
  const lines = frontmatter(text);
  if (!lines) return { name: "", description: "", keywords: [] };

  let name = "";
  let description = "";
  const routing = { keywords: [], examples: [] };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const entry = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!entry) continue;
    const key = entry[1];

    if (key === "name" || key === "description") {
      const parsed = parseScalar(entry[2], lines, index + 1, 0);
      if (key === "name") name = parsed.value;
      else description = parsed.value;
      index = parsed.next - 1;
      continue;
    }

    if (key === "routing") {
      const parsed = parseRouting(entry[2], lines, index + 1, 0);
      routing.keywords = parsed.routing.keywords;
      routing.examples = parsed.routing.examples;
      index = parsed.next - 1;
      continue;
    }

    if (key === "routing.keywords" || key === "routing.examples") {
      const field = key.slice("routing.".length);
      const parsed = parseArray(entry[2], lines, index + 1, 0);
      routing[field] = parsed.value;
      index = parsed.next - 1;
    }
  }

  return {
    name: name.replace(/\s+/g, " ").trim(),
    description: description.replace(/\s+/g, " ").trim(),
    keywords: routing.keywords.map((keyword) => keyword.trim()).filter(Boolean),
  };
}

/** Scan `<root>/<skill>/SKILL.md` in every configured root. Missing roots and unreadable files are skipped. */
export function listSkills(root, config) {
  const found = new Map();
  for (const dir of skillRoots(root, config)) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const entry of entries) {
      const skillDir = path.join(dir, entry);
      const file = path.join(skillDir, "SKILL.md");
      let text;
      try {
        if (!fs.statSync(skillDir).isDirectory()) continue;
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillText(text);
      const name = parsed.name || entry;
      if (found.has(name)) continue;
      found.set(name, {
        name,
        description: parsed.description,
        path: displayPath(root, file),
        keywords: parsed.keywords,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
