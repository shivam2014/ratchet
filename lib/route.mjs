// @ts-check
import { createHash } from "node:crypto";
import path from "node:path";
import { writeJson } from "./fsx.mjs";
import {
  createContract,
  loadConfig,
  loadRun,
  runDir,
  saveContract,
} from "./contract.mjs";

export const DEFAULT_AUTO = {
  enabled: true,
  profile: "general",
  role: "coder",
  scope: ["**"],
  deny: [],
  gates: [],
  maxFiles: 40,
  maxWrites: 120,
};

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item);
  if (typeof value === "string" && value) return [value];
  return [];
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The repo owns the auto policy. Missing `auto` means the old manual flow. */
export function autoPolicy(root) {
  const config = loadConfig(root);
  if (!config?.auto || config.auto.enabled !== true) return null;
  const auto = { ...DEFAULT_AUTO, ...config.auto };
  const scope = asArray(auto.scope);
  return {
    ...auto,
    scope: scope.length ? scope : DEFAULT_AUTO.scope,
    deny: [...asArray(config.defaults?.deny), ...asArray(auto.deny)],
    gates: Array.isArray(auto.gates) ? auto.gates : [],
    maxFiles: positiveInt(auto.maxFiles, DEFAULT_AUTO.maxFiles),
    maxWrites: positiveInt(auto.maxWrites, DEFAULT_AUTO.maxWrites),
    verify: asArray(auto.verify).length ? asArray(auto.verify) : (config.checks ?? []).map((check) => check.cmd),
  };
}

/**
 * Create a contract from a prompt only when the repo opted in with
 * `auto.enabled`. The prompt is hashed; its text never reaches the contract.
 */
export function routePrompt(root, event) {
  const existing = loadRun(root);
  if (existing) return { contract: existing, created: false, route: null };

  const auto = autoPolicy(root);
  if (!auto) return { contract: null, created: false, route: null, reason: "auto contract disabled" };
  const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
  if (!prompt) return { contract: null, created: false, route: null, reason: "empty prompt" };

  const promptHash = sha256(prompt);
  const artifactScope = auto.gates
    .map((gate) => gate?.artifact)
    .filter((artifact) => typeof artifact === "string" && artifact);
  const contract = createContract(root, {
    goal: `auto task ${promptHash.slice(0, 8)}`,
    role: auto.role,
    readOnly: false,
    scope: [...new Set([...auto.scope, ...artifactScope])],
    deny: auto.deny,
    gates: auto.gates,
    maxFiles: auto.maxFiles,
    maxWrites: auto.maxWrites,
    verify: auto.verify,
  });
  contract.harness = event.harness;
  contract.session_id = event.session_id;
  contract.profile = auto.profile;
  contract.auto = true;
  saveContract(root, contract);

  const route = {
    version: 1,
    prompt_sha256: promptHash,
    prompt_length: prompt.length,
    harness: event.harness,
    session_id: event.session_id,
    profile: auto.profile,
    decision: "auto",
    skills: [],
    policy: {
      scope: auto.scope,
      maxFiles: auto.maxFiles,
      maxWrites: auto.maxWrites,
      verify: auto.verify,
      gates: auto.gates.map((gate) => gate?.artifact).filter(Boolean),
    },
    policy_sha256: sha256(JSON.stringify(auto)),
    created_at: new Date().toISOString(),
  };
  writeJson(path.join(runDir(root, contract.id), "route.json"), route);
  return { contract, created: true, route };
}
