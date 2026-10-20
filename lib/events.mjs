// @ts-check
import { createHash } from "node:crypto";
import { appendJsonl } from "./fsx.mjs";
import { eventsPath, loadRunForSession } from "./contract.mjs";

export const EVENT_VERSION = 1;

export const EVENT_TYPES = ["prompt.submit", "tool.before", "tool.after", "turn.stop"];

/** @type {Record<string, { required: string[]; optional: string[] }>} */
export const EVENT_SCHEMA = {
  "prompt.submit": { required: ["harness", "session_id", "prompt"], optional: ["cwd"] },
  "tool.before": { required: ["harness", "session_id", "tool", "input"], optional: ["cwd"] },
  "tool.after": { required: ["harness", "session_id", "tool", "input", "result"], optional: ["cwd"] },
  "turn.stop": { required: ["harness", "session_id"], optional: ["cwd", "last_message"] },
};

/** @type {Record<string, string[]>} */
export const DECISION_SCHEMA = {
  "prompt.submit": ["context"],
  "tool.before": ["allow", "reason"],
  "tool.after": ["continue", "context"],
  "turn.stop": ["allow", "reason", "certified", "evidence", "checksLock"],
};

const BASE_FIELDS = new Set(["harness", "session_id", "cwd"]);

export class EventError extends Error {
  constructor(message) {
    super(message);
    this.name = "EventError";
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalid(type, field, expected) {
  return new EventError(`event ${type} field "${field}" must be ${expected}`);
}

/** @type {Record<string, (value: any, type: string) => any>} */
const VALIDATORS = {
  harness(value, type) {
    if (typeof value !== "string" || !value) throw invalid(type, "harness", "a non-empty string");
    return value;
  },
  session_id(value, type) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    throw invalid(type, "session_id", "a string or a finite number");
  },
  cwd(value, type) {
    if (typeof value !== "string") throw invalid(type, "cwd", "a string");
    return value;
  },
  prompt(value, type) {
    if (typeof value !== "string") throw invalid(type, "prompt", "a string");
    return value;
  },
  tool(value, type) {
    if (typeof value !== "string" || !value) throw invalid(type, "tool", "a non-empty string");
    return value;
  },
  input(value, type) {
    if (!isPlainObject(value)) throw invalid(type, "input", "an object");
    return value;
  },
  result(value, type) {
    if (!isPlainObject(value)) throw invalid(type, "result", "an object");
    return value;
  },
  last_message(value, type) {
    if (value === null) return null;
    if (typeof value !== "string") throw invalid(type, "last_message", "a string");
    return value;
  },
};

export function parseEvent(raw) {
  if (!isObject(raw)) throw new EventError("event must be a JSON object");

  const version = raw.version === undefined ? EVENT_VERSION : raw.version;
  if (version !== EVENT_VERSION) {
    throw new EventError(`event version ${String(version)} is not supported (expected ${EVENT_VERSION})`);
  }

  if (typeof raw.type !== "string" || !raw.type) {
    throw new EventError(`event type is required; valid types: ${EVENT_TYPES.join(", ")}`);
  }
  if (!Object.hasOwn(EVENT_SCHEMA, raw.type)) {
    throw new EventError(`event type "${raw.type}" is not supported; valid types: ${EVENT_TYPES.join(", ")}`);
  }
  const type = raw.type;
  const schema = EVENT_SCHEMA[type];

  for (const field of schema.required) {
    if (raw[field] === undefined) throw new EventError(`event ${type} needs "${field}"`);
  }

  /** @type {Record<string, any>} */
  const event = { version, type };
  event.harness = VALIDATORS.harness(raw.harness, type);
  event.session_id = VALIDATORS.session_id(raw.session_id, type);
  event.cwd = raw.cwd === undefined ? process.cwd() : VALIDATORS.cwd(raw.cwd, type);

  for (const field of [...schema.required, ...schema.optional]) {
    if (BASE_FIELDS.has(field)) continue;
    if (raw[field] === undefined) {
      if (field === "last_message") event[field] = null;
      continue;
    }
    event[field] = VALIDATORS[field](raw[field], type);
  }
  return event;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function opFor(type) {
  if (type === "prompt.submit") return "prompt";
  if (type === "turn.stop") return "stop";
  return "observe";
}

function toolFor(event) {
  if (event.tool) return event.tool;
  if (event.type === "prompt.submit") return "prompt";
  if (event.type === "turn.stop") return "stop";
  return "unknown";
}

function stopChecks(checks) {
  if (Array.isArray(checks)) return checks.map((c) => ({ id: c.id, status: c.status }));
  if (Array.isArray(checks?.results)) return checks.results.map((c) => ({ id: c.id, status: c.status }));
  return null;
}

/** Build a JSONL row. Prompt and last-message text never reach the trail. */
export function rowFor(event, decision) {
  /** @type {Record<string, any>} */
  if (event.type === "tool.before") {
    throw new EventError("tool.before rows belong to record(); appendEvent covers prompt.submit, tool.after, and turn.stop");
  }
  const row = {
    ts: new Date().toISOString(),
    type: event.type,
    harness: event.harness,
    session_id: event.session_id,
    tool: toolFor(event),
    op: opFor(event.type),
    decision:
      event.type === "prompt.submit" || event.type === "tool.after"
        ? "observed"
        : decision.allow === false
          ? "block"
          : "allow",
  };

  if (event.type === "prompt.submit") {
    row.prompt_sha256 = sha256(event.prompt);
    row.prompt_length = event.prompt.length;
    if (decision.run !== undefined) row.run = decision.run;
  }

  if (event.type === "tool.after") {
    const exit = typeof event.result?.exit === "number" && Number.isFinite(event.result.exit) ? event.result.exit : null;
    row.exit = exit;
    row.ok = typeof event.result?.ok === "boolean" ? event.result.ok : exit === null ? true : exit === 0;
  }

  if (event.type === "turn.stop") {
    if (event.last_message !== null) {
      row.last_message_sha256 = sha256(event.last_message);
      row.last_message_length = event.last_message.length;
    }
    row.certified = Boolean(decision.certified);
    row.attempts = decision.attempts;
    row.max_attempts = decision.maxAttempts;
    row.evidence = decision.evidence ?? null;
    row.checks = stopChecks(decision.checks);
    row.checks_lock = decision.checksLock ?? null;
  }

  return row;
}

export function appendEvent(root, event, decision) {
  const contract = loadRunForSession(root, event.session_id);
  if (!contract) return null;
  appendJsonl(eventsPath(root, contract.id), rowFor(event, decision));
  return contract.id;
}
