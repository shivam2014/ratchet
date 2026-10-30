// @ts-check
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BRIEF_FILE = path.join(".ratchet", "requirements.md");

/**
 * The intake questions. The headings are the stable part of the file: the
 * validator and the renderer both key on them, so a brief written by hand and
 * one rendered by `ratchet brief --from` mean the same thing.
 */
export const QUESTIONS = Object.freeze([
  {
    key: "outcome",
    heading: "Outcome and success",
    prompt: "What outcome is required, and how will you know it succeeded?",
  },
  {
    key: "never",
    heading: "What must never happen",
    prompt: "Which regressions, data loss, security failures, or destructive actions are unacceptable?",
  },
  {
    key: "outOfScope",
    heading: "Out of scope",
    prompt: "What is explicitly not part of this task?",
  },
  {
    key: "constraints",
    heading: "Constraints",
    prompt: "Which technical, product, compatibility, budget, or deadline constraints apply?",
  },
  {
    key: "irreversible",
    heading: "Irreversible decisions",
    prompt: "Which choices are hard to undo (schema, public API, data migration, release) and who owns them?",
  },
  {
    key: "verification",
    heading: "How it will be verified",
    prompt: "Which command, test, or review proves the outcome? It must be able to fail.",
  },
  {
    key: "patterns",
    heading: "Existing patterns and rules",
    prompt: "Which existing modules, conventions, and repository rules must the work follow?",
  },
  {
    key: "unknowns",
    heading: "Unknowns and prototypes",
    prompt: "What is still unknown, and what should be prototyped or measured before committing?",
  },
]);

const PLACEHOLDER = /^(?:tbd|todo|tktk|fixme|xxx|\?+|-+|\.+|…)$/i;

export function briefPath(root, file = BRIEF_FILE) {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stripComments(text) {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
}

/** Placeholder-only answers (TBD, TODO, ...) do not satisfy a section. */
function contentIsPlaceholder(text) {
  const stripped = stripComments(text).trim();
  if (!stripped) return true;
  const lines = stripped
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
  if (!lines.length) return true;
  return lines.every((line) => {
    const flat = line
      .replace(/[*_`~]/g, "")
      .replace(/^[\[\]()<>]+|[\[\]()<>]+$/g, "")
      .trim()
      .replace(/[.!:;]+$/, "")
      .trim();
    return PLACEHOLDER.test(flat);
  });
}

function normaliseAnswer(value) {
  const text = stripComments(answerText(value)).trim();
  return text && !contentIsPlaceholder(text) ? text : "";
}

function answerText(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join("\n");
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function pickAnswer(answers, question) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return "";
  const wanted = [question.key.toLowerCase(), question.heading.toLowerCase()];
  for (const target of wanted) {
    for (const [key, value] of Object.entries(answers)) {
      if (String(key).toLowerCase() === target) return normaliseAnswer(value);
    }
  }
  return "";
}

function parseSections(text) {
  /** @type {Map<string, string[]>} */
  const sections = new Map();
  let current = null;
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (/^#\s+/.test(line)) {
      current = null;
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [heading, body] of sections) out.set(heading, normaliseAnswer(body.join("\n")));
  return out;
}

/** The empty template. It is also the stable shape every rendered brief uses. */
export function scaffoldBrief() {
  return renderBrief({});
}

/** Render answers (keyed by question key or heading) to stable Markdown. */
export function renderBrief(answers = {}) {
  const lines = [
    "# Requirements",
    "",
    "<!-- Filled by `ratchet brief`. A contract started with --require-brief locks this file's hash. -->",
    "",
  ];
  for (const question of QUESTIONS) {
    const answer = pickAnswer(answers, question);
    lines.push(`## ${question.heading}`, "");
    if (answer) lines.push(answer, "");
    else lines.push(`<!-- ${question.prompt} -->`, "");
  }
  return lines.join("\n");
}

/**
 * Validate the brief on disk. A missing file, a missing section, or a section
 * whose only content is a placeholder (TBD/TODO/...) is reported in `missing`.
 * `hash` is the raw file hash so check/done can detect any edit after the lock.
 */
export function validateBrief(root, file = BRIEF_FILE) {
  const target = briefPath(root, file);
  let text;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return {
      ok: false,
      missing: QUESTIONS.map((question) => question.heading),
      hash: null,
      file: target,
      exists: false,
    };
  }
  const sections = parseSections(text);
  const missing = QUESTIONS.filter((question) => !sections.get(question.heading.toLowerCase())).map(
    (question) => question.heading,
  );
  return { ok: missing.length === 0, missing, hash: sha256(text), file: target, exists: true };
}

/**
 * Parse an answers file. JSON uses an object keyed by question key or heading;
 * Markdown uses `## <heading>` sections like the rendered brief. Throws with a
 * human-readable message when the file cannot be interpreted.
 */
export function parseAnswers(text, file = "") {
  const raw = String(text ?? "");
  const extension = path.extname(String(file)).toLowerCase();
  const looksJson = extension === ".json" || (!extension && raw.trimStart().startsWith("{"));
  if (looksJson) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`answers file is not valid JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("answers JSON must be an object keyed by question key or heading");
    }
    return parsed;
  }
  return Object.fromEntries(parseSections(raw));
}
