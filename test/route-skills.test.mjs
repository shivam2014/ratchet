import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listSkills, skillRoots } from "../lib/skills.mjs";
import { routePrompt } from "../lib/route.mjs";
import { defaultConfig, loadConfig, saveConfig } from "../lib/contract.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const TDD_DESCRIPTION = "Write the test first, then make it pass.";
const TDD_BODY = "Secret skill body that route metadata must never carry.";
const PLAN_GATE = {
  artifact: ".ratchet/plan.md",
  before: ["src/**"],
  message: "write the plan before the source",
};
const NOTES_GATE = { artifact: ".ratchet/notes.md", before: ["src/**"] };

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-route-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSkill(root, name, text, body = "") {
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${text}\n${body ? `${body}\n` : ""}`);
}

function tddSkill(root) {
  writeSkill(
    root,
    "tdd",
    [
      "---",
      "name: tdd",
      "description: >",
      `  ${TDD_DESCRIPTION}`,
      "routing:",
      "  keywords: [test, tdd, red-green]",
      "  examples:",
      '    - "write the test first"',
      '    - "add a regression test"',
      "---",
      "# tdd",
    ].join("\n"),
    TDD_BODY,
  );
}

function repo(t, auto = {}) {
  const root = temp(t);
  saveConfig(root, {
    ...defaultConfig(root),
    checks: [{ id: "check", cmd: 'node -e "process.exit(0)"' }],
    auto: { enabled: true, skillRoots: [".agents/skills"], ...auto },
  });
  return root;
}

function promptEvent(root, text = "build a flappy game") {
  return { type: "prompt.submit", harness: "test", session_id: "s-1", prompt: text, cwd: root };
}

function toolEvent(root, file) {
  return { type: "tool.before", harness: "test", session_id: "s-1", tool: "write", input: { path: file }, cwd: root };
}

function run(root, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, input, encoding: "utf8" });
}

function hook(root, event) {
  return run(root, ["hook"], JSON.stringify(event));
}

function routeJson(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, ".ratchet", "runs", id, "route.json"), "utf8"));
}

test("skills: roots expand ~, dedupe, and keep existing directories", (t) => {
  const root = temp(t);
  const local = path.join(root, ".agents", "skills");
  fs.mkdirSync(local, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-skills-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const roots = skillRoots(root, {
    auto: { skillRoots: [".agents/skills", "./.agents/skills", outside, "missing-root", "~"] },
  });

  assert.deepEqual(roots, [local, outside, os.homedir()]);
});

test("skills: listSkills parses frontmatter, keywords, and skips missing entries", (t) => {
  const root = repo(t, { skillRoots: ["missing-root", ".agents/skills"] });
  tddSkill(root);
  writeSkill(root, "plain", ["---", "name: plain", "description: 'A plain skill.'", "---"].join("\n"));
  writeSkill(root, "notes", ["---", "name: notes", "description: |", "  First line.", "  Second line.", "---"].join("\n"));
  fs.mkdirSync(path.join(root, ".agents", "skills", "no-file"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "skills", "not-a-dir"), "x");

  const skills = listSkills(root, loadConfig(root));
  assert.deepEqual(skills.map((skill) => skill.name), ["notes", "plain", "tdd"]);

  const tdd = skills.find((skill) => skill.name === "tdd");
  assert.equal(tdd.description, TDD_DESCRIPTION);
  assert.equal(tdd.path, ".agents/skills/tdd/SKILL.md");
  assert.deepEqual(tdd.keywords, ["test", "tdd", "red-green"]);

  assert.equal(skills.find((skill) => skill.name === "plain").description, "A plain skill.");
  assert.equal(skills.find((skill) => skill.name === "notes").description, "First line. Second line.");
  assert.equal(JSON.stringify(skills).includes(TDD_BODY), false);
});

test("route: a matching route sets profile, skill metadata, and merged gates", (t) => {
  const root = repo(t, {
    scope: ["src/**"],
    routes: [{ match: ["flappy", "game"], profile: "feature", skills: ["tdd"], gates: [PLAN_GATE] }],
    gates: [NOTES_GATE],
  });
  tddSkill(root);

  const text = "Build a FLAPPY bird game with a secret acceptance phrase";
  const routed = routePrompt(root, promptEvent(root, text));

  assert.equal(routed.created, true);
  assert.equal(routed.contract.profile, "feature");
  assert.deepEqual(routed.contract.skills, [
    { name: "tdd", path: ".agents/skills/tdd/SKILL.md", description: TDD_DESCRIPTION },
  ]);
  assert.deepEqual(routed.contract.gates.map((gate) => gate.artifact), [".ratchet/plan.md", ".ratchet/notes.md"]);
  assert.deepEqual(routed.contract.scope, ["src/**", ".ratchet/plan.md", ".ratchet/notes.md"]);

  const route = routeJson(root, routed.contract.id);
  assert.equal(route.decision, "route");
  assert.equal(route.profile, "feature");
  assert.deepEqual(route.matched, ["flappy", "game"]);
  assert.deepEqual(route.skills, routed.contract.skills);
  assert.deepEqual(route.policy.gates, [".ratchet/plan.md", ".ratchet/notes.md"]);
  assert.match(route.prompt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(route).includes(text), false);
  assert.equal(JSON.stringify(route).includes(TDD_BODY), false);

  const contract = fs.readFileSync(path.join(root, ".ratchet", "runs", routed.contract.id, "contract.json"), "utf8");
  assert.equal(contract.includes(text), false);
  assert.equal(contract.includes(TDD_BODY), false);
});

test("route: no match falls back to general with no skills or route gates", (t) => {
  const root = repo(t, {
    scope: ["src/**"],
    routes: [{ match: ["flappy", "game"], profile: "feature", skills: ["tdd"], gates: [PLAN_GATE] }],
    gates: [NOTES_GATE],
  });
  tddSkill(root);

  const routed = routePrompt(root, promptEvent(root, "refactor the docs"));
  assert.equal(routed.contract.profile, "general");
  assert.deepEqual(routed.contract.skills, []);
  assert.deepEqual(routed.contract.gates.map((gate) => gate.artifact), [".ratchet/notes.md"]);
  assert.deepEqual(routed.contract.scope, ["src/**", ".ratchet/notes.md"]);

  const route = routeJson(root, routed.contract.id);
  assert.equal(route.decision, "default");
  assert.deepEqual(route.skills, []);
  assert.deepEqual(route.matched, []);
});

test("route: the first matching route wins", (t) => {
  const root = repo(t, {
    routes: [
      { match: ["flappy"], profile: "first" },
      { match: ["game"], profile: "second" },
    ],
  });

  const routed = routePrompt(root, promptEvent(root, "build a flappy game"));
  assert.equal(routed.contract.profile, "first");
  assert.equal(routeJson(root, routed.contract.id).decision, "route");
});

test("route: route gates block source until the artifact exists", (t) => {
  const root = repo(t, {
    scope: ["src/**"],
    routes: [{ match: ["flappy", "game"], profile: "feature", skills: ["tdd"], gates: [PLAN_GATE] }],
  });
  tddSkill(root);

  const submit = hook(root, promptEvent(root));
  assert.equal(submit.status, 0, submit.stderr);

  const blocked = hook(root, toolEvent(root, "src/game.mjs"));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /plan\.md/);

  const plan = hook(root, toolEvent(root, ".ratchet/plan.md"));
  assert.equal(plan.status, 0, plan.stderr);

  fs.writeFileSync(path.join(root, ".ratchet", "plan.md"), "# plan\n");
  const allowed = hook(root, toolEvent(root, "src/game.mjs"));
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("brief: names the profile, skill path, and skill description", (t) => {
  const root = repo(t, {
    scope: ["src/**"],
    routes: [{ match: ["flappy", "game"], profile: "feature", skills: ["tdd"], gates: [PLAN_GATE] }],
  });
  tddSkill(root);

  const submit = hook(root, promptEvent(root));
  assert.equal(submit.status, 0, submit.stderr);
  const context = JSON.parse(submit.stdout).context;

  assert.match(context, /Profile: feature/);
  assert.match(context, /Likely skills:/);
  assert.match(context, /- tdd {2}\.agents\/skills\/tdd\/SKILL\.md {2}Write the test first, then make it pass\./);
  assert.match(context, /Read these skill files before coding\. If none apply, say so\./);
  assert.equal(context.includes(TDD_BODY), false);

  const printed = run(root, ["prompt"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /Profile: feature/);
  assert.match(printed.stdout, /Likely skills:/);
});

test("brief: a contract without profile or skills keeps the old output", (t) => {
  const root = temp(t);
  saveConfig(root, defaultConfig(root));

  const start = run(root, ["task", "start", "--role", "coder", "--goal", "manual task", "--scope", "src/**"]);
  assert.equal(start.status, 0, start.stderr);

  const printed = run(root, ["prompt"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /Goal: manual task/);
  assert.match(printed.stdout, /Write scope: src\/\*\*/);
  assert.doesNotMatch(printed.stdout, /Profile:/);
  assert.doesNotMatch(printed.stdout, /Likely skills:/);
});
