// @ts-check
import { createHash } from "node:crypto";
import path from "node:path";
import { writeJson } from "./fsx.mjs";
import { lockCheckSurface } from "./check-surface.mjs";
import {
  createContract,
  loadConfig,
  loadRun,
  runDir,
  saveContract,
} from "./contract.mjs";
import { listSkills } from "./skills.mjs";

export const DEFAULT_AUTO = {
  enabled: true,
  profile: "general",
  role: "coder",
  scope: ["**"],
  deny: [],
  routes: [],
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
export function autoPolicy(root, config = loadConfig(root)) {
  if (!config?.auto || config.auto.enabled !== true) return null;
  const auto = { ...DEFAULT_AUTO, ...config.auto };
  const scope = asArray(auto.scope);
  return {
    ...auto,
    profile: typeof auto.profile === "string" && auto.profile.trim() ? auto.profile.trim() : DEFAULT_AUTO.profile,
    scope: scope.length ? scope : DEFAULT_AUTO.scope,
    deny: [...asArray(config.defaults?.deny), ...asArray(auto.deny)],
    routes: Array.isArray(auto.routes) ? auto.routes : DEFAULT_AUTO.routes,
    gates: [
      ...(Array.isArray(config.gates) ? config.gates : []),
      ...(Array.isArray(auto.gates) ? auto.gates : []),
    ],
    maxFiles: positiveInt(auto.maxFiles, DEFAULT_AUTO.maxFiles),
    maxWrites: positiveInt(auto.maxWrites, DEFAULT_AUTO.maxWrites),
    verify: asArray(auto.verify).length ? asArray(auto.verify) : (config.checks ?? []).map((check) => check.cmd),
  };
}

function routeTable(routes, fallbackProfile) {
  const table = [];
  for (const route of Array.isArray(routes) ? routes : []) {
    if (!route || typeof route !== "object") continue;
    const match = asArray(route.match).map((term) => term.trim()).filter(Boolean);
    if (!match.length) continue;
    table.push({
      match,
      profile: typeof route.profile === "string" && route.profile.trim() ? route.profile.trim() : fallbackProfile,
      skills: asArray(route.skills),
      gates: Array.isArray(route.gates) ? route.gates.filter((gate) => gate && typeof gate === "object") : [],
    });
  }
  return table;
}

/** Every term must appear. A route table is the explicit, high-precision stage. */
function matchRoute(table, prompt) {
  const haystack = prompt.toLowerCase();
  for (const route of table) {
    if (route.match.every((term) => haystack.includes(term.toLowerCase()))) return route;
  }
  return null;
}

/** Names become metadata only. A named skill that is not installed keeps a null path so the gap is visible. */
function skillMetadata(root, config, names) {
  const requested = [...new Set(names)];
  if (!requested.length) return [];
  const registry = new Map(listSkills(root, config).map((skill) => [skill.name, skill]));
  return requested.map((name) => {
    const skill = registry.get(name);
    return skill
      ? { name: skill.name, path: skill.path, description: skill.description }
      : { name, path: null, description: null };
  });
}

/**
 * Create a contract from a prompt only when the repo opted in with
 * `auto.enabled`. The prompt is hashed; its text never reaches the contract.
 */
export function routePrompt(root, event) {
  const existing = loadRun(root);
  if (existing) return { contract: existing, created: false, route: null };

  const config = loadConfig(root);
  const auto = autoPolicy(root, config);
  if (!auto) return { contract: null, created: false, route: null, reason: "auto contract disabled" };
  const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
  if (!prompt) return { contract: null, created: false, route: null, reason: "empty prompt" };

  const promptHash = sha256(prompt);
  const matched = matchRoute(routeTable(auto.routes, auto.profile), prompt);
  const profile = matched?.profile ?? auto.profile;
  const skills = skillMetadata(root, config, matched?.skills ?? []);
  const gates = [...(matched?.gates ?? []), ...auto.gates];
  const artifactScope = gates
    .map((gate) => gate?.artifact)
    .filter((artifact) => typeof artifact === "string" && artifact);
  const contract = createContract(root, {
    goal: `auto task ${promptHash.slice(0, 8)}`,
    role: auto.role,
    profile,
    skills,
    readOnly: false,
    scope: [...new Set([...auto.scope, ...artifactScope])],
    deny: auto.deny,
    gates,
    maxFiles: auto.maxFiles,
    maxWrites: auto.maxWrites,
    verify: auto.verify,
    checkSurface: lockCheckSurface(root, auto.verify),
  });
  contract.harness = event.harness;
  contract.session_id = event.session_id;
  contract.auto = true;
  saveContract(root, contract);

  const route = {
    version: 1,
    prompt_sha256: promptHash,
    prompt_length: prompt.length,
    harness: event.harness,
    session_id: event.session_id,
    profile,
    decision: matched ? "route" : "default",
    skills,
    matched: matched?.match ?? [],
    policy: {
      profile,
      scope: auto.scope,
      skills: skills.map((skill) => skill.name),
      maxFiles: auto.maxFiles,
      maxWrites: auto.maxWrites,
      verify: auto.verify,
      gates: gates.map((gate) => gate?.artifact).filter(Boolean),
    },
    policy_sha256: sha256(JSON.stringify(auto)),
    created_at: new Date().toISOString(),
  };
  writeJson(path.join(runDir(root, contract.id), "route.json"), route);
  return { contract, created: true, route };
}
