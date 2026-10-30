import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { QUESTIONS, renderBrief, scaffoldBrief, validateBrief } from "../lib/brief.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");
const VERIFY = 'node -e "process.exit(0)"';

const ANSWERS = {
  outcome: "Ship the retry path for failed uploads.",
  never: "Never retry a non-idempotent upload or drop an error.",
  outOfScope: "No changes to the UI or the public API.",
  constraints: "Keep the existing Node 20 support and the upload budget.",
  irreversible: "No schema migration in this task; the human owns that decision.",
  verification: "npm test",
  patterns: "Follow src/upload/uploader.js and the existing retry helper.",
  unknowns: "Measure backoff at a 10% failure rate before shipping.",
};

function repo(t, scripts = { check: VERIFY }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-brief-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "brief", private: true, scripts }, null, 2));
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "base"],
    { cwd: dir },
  );
  return dir;
}

function ratchet(dir, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, input, encoding: "utf8" });
}

function briefFile(dir) {
  return path.join(dir, ".ratchet", "requirements.md");
}

function fillBrief(dir, overrides = {}) {
  fs.mkdirSync(path.join(dir, ".ratchet"), { recursive: true });
  fs.writeFileSync(briefFile(dir), renderBrief({ ...ANSWERS, ...overrides }));
}

function start(dir, extra = []) {
  return ratchet(dir, [
    "task", "start",
    "--role", "coder",
    "--goal", "ship retries",
    "--scope", "src/**",
    "--verify", VERIFY,
    ...extra,
  ]);
}

function contractOf(dir) {
  const id = fs.readFileSync(path.join(dir, ".ratchet", "current"), "utf8").trim();
  return JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "runs", id, "contract.json"), "utf8"));
}

test("brief: the scaffold has all eight questions and validates as incomplete", (t) => {
  const dir = repo(t);
  fs.mkdirSync(path.join(dir, ".ratchet"), { recursive: true });
  fs.writeFileSync(briefFile(dir), scaffoldBrief());

  assert.equal(renderBrief({}), scaffoldBrief());
  for (const question of QUESTIONS) assert.match(scaffoldBrief(), new RegExp(`^## ${question.heading}$`, "m"));

  const result = validateBrief(dir);
  assert.equal(result.ok, false);
  assert.equal(result.exists, true);
  assert.deepEqual(result.missing, QUESTIONS.map((question) => question.heading));
  assert.match(result.hash, /^[a-f0-9]{64}$/);

  const missingFile = validateBrief(repo(t));
  assert.equal(missingFile.ok, false);
  assert.equal(missingFile.exists, false);
  assert.equal(missingFile.hash, null);
  assert.equal(missingFile.missing.length, 8);
});

test("brief: placeholder-only sections do not count", (t) => {
  const dir = repo(t);
  fillBrief(dir, { never: "TBD.", outOfScope: "- [TODO]" });

  const result = validateBrief(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["What must never happen", "Out of scope"]);
});

test("brief: a complete brief validates and the hash tracks the content", (t) => {
  const dir = repo(t);
  fillBrief(dir);

  const first = validateBrief(dir);
  assert.equal(first.ok, true);
  assert.deepEqual(first.missing, []);
  assert.match(first.hash, /^[a-f0-9]{64}$/);

  fillBrief(dir, { outcome: "Ship retries and record the reason." });
  const second = validateBrief(dir);
  assert.equal(second.ok, true);
  assert.notEqual(second.hash, first.hash);
});

test("brief CLI: --init writes the template and refuses to overwrite without --force", (t) => {
  const dir = repo(t);

  const init = ratchet(dir, ["brief", "--init"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /ratchet brief --check/);
  assert.equal(fs.readFileSync(briefFile(dir), "utf8"), scaffoldBrief());

  const again = ratchet(dir, ["brief", "--init"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.match(again.stderr, /ratchet brief --check/);
  assert.match(again.stderr, /ratchet brief --init --force/);

  const forced = ratchet(dir, ["brief", "--init", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(fs.readFileSync(briefFile(dir), "utf8"), scaffoldBrief());
});

test("brief CLI: --check names every missing section", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["brief", "--init"]).status, 0);

  const incomplete = ratchet(dir, ["brief", "--check"]);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /brief is incomplete/);
  assert.match(incomplete.stderr, /Outcome and success/);
  assert.match(incomplete.stderr, /Unknowns and prototypes/);
  assert.match(incomplete.stderr, /ratchet brief --check/);

  fillBrief(dir);
  const valid = ratchet(dir, ["brief", "--check"]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /brief: valid/);
  assert.match(valid.stdout, /hash:\s+[a-f0-9]{64}/);
});

test("brief CLI: --from renders JSON and Markdown answers", (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(ANSWERS, null, 2));

  const fromJson = ratchet(dir, ["brief", "--from", "answers.json"]);
  assert.equal(fromJson.status, 0, fromJson.stderr);
  assert.match(fromJson.stdout, /valid/);
  assert.equal(validateBrief(dir).ok, true);
  assert.match(fs.readFileSync(briefFile(dir), "utf8"), /Ship the retry path/);

  const markdown = [
    "# Requirements",
    "",
    ...QUESTIONS.flatMap((question) => [
      `## ${question.heading}`,
      "",
      `Answer for ${question.heading}.`,
      "",
    ]),
  ].join("\n");
  fs.writeFileSync(path.join(dir, "answers.md"), markdown);
  const fromMarkdown = ratchet(dir, ["brief", "--from", "answers.md"]);
  assert.equal(fromMarkdown.status, 0, fromMarkdown.stderr);
  assert.equal(validateBrief(dir).ok, true);
  assert.match(fs.readFileSync(briefFile(dir), "utf8"), /Answer for Existing patterns and rules/);

  fs.writeFileSync(path.join(dir, "bad.json"), "{ not json");
  const bad = ratchet(dir, ["brief", "--from", "bad.json"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not valid JSON/);
  assert.match(bad.stderr, /ratchet brief --init/);
});

test("task start --require-brief refuses a missing or incomplete brief", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);

  const missing = start(dir, ["--require-brief"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--require-brief needs \.ratchet\/requirements\.md/);
  assert.match(missing.stderr, /ratchet brief --init/);

  assert.equal(ratchet(dir, ["brief", "--init"]).status, 0);
  const incomplete = start(dir, ["--require-brief"]);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /is incomplete/);
  assert.match(incomplete.stderr, /ratchet brief --check/);
  assert.equal(fs.existsSync(path.join(dir, ".ratchet", "current")), false);
});

test("task start --require-brief stores the requirements hash", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  fillBrief(dir);

  const started = start(dir, ["--require-brief"]);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /brief:\s+\.ratchet\/requirements\.md/);

  const contract = contractOf(dir);
  assert.equal(contract.requireBrief, true);
  assert.equal(contract.requirementsHash, validateBrief(dir).hash);
});

test("done refuses after the brief changes, and amend --brief records the new hash", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  fillBrief(dir);
  assert.equal(start(dir, ["--require-brief"]).status, 0);
  assert.equal(ratchet(dir, ["check"]).status, 0);

  fillBrief(dir, { constraints: "Keep the API stable, and no dependency upgrades." });

  const refusedCheck = ratchet(dir, ["check"]);
  assert.equal(refusedCheck.status, 1);
  assert.match(refusedCheck.stderr, /requirements\.md changed/);
  assert.match(refusedCheck.stderr, /ratchet amend --brief --reason/);

  const refusedDone = ratchet(dir, ["done"]);
  assert.equal(refusedDone.status, 1);
  assert.match(refusedDone.stderr, /requirements\.md changed/);

  const amended = ratchet(dir, ["amend", "--brief", "--reason", "clarified the constraint"]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.match(amended.stdout, /AMENDED/);
  assert.match(amended.stdout, /requirements:/);

  const contract = contractOf(dir);
  assert.equal(contract.requirementsAmendments.length, 1);
  assert.equal(contract.requirementsAmendments[0].reason, "clarified the constraint");
  assert.match(contract.requirementsAmendments[0].from, /^[a-f0-9]{64}$/);
  assert.match(contract.requirementsAmendments[0].to, /^[a-f0-9]{64}$/);
  assert.equal(contract.requirementsHash, validateBrief(dir).hash);

  assert.equal(ratchet(dir, ["check"]).status, 0);
  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /requirements amended: clarified the constraint/);

  const result = JSON.parse(
    fs.readFileSync(path.join(dir, ".ratchet", "runs", contract.id, "result.json"), "utf8"),
  );
  assert.equal(result.requirements.hash, validateBrief(dir).hash);
  assert.equal(result.requirements.amendments.length, 1);
});

test("done refuses when the required brief disappears", (t) => {
  const dir = repo(t);
  assert.equal(ratchet(dir, ["init"]).status, 0);
  fillBrief(dir);
  assert.equal(start(dir, ["--require-brief"]).status, 0);
  assert.equal(ratchet(dir, ["check"]).status, 0);

  fs.rmSync(briefFile(dir));
  const done = ratchet(dir, ["done"]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /requires \.ratchet\/requirements\.md, but the file is missing/);
  assert.match(done.stderr, /ratchet abandon --reason/);
});
