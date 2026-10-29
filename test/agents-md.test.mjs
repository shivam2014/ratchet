import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MANAGED, MANAGED_START, renderAgents, syncAgents } from "../lib/agents-md.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-agents-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("agents: appends the managed block", () => {
  const out = renderAgents("# Project\n");
  assert.match(out, /# Project/);
  assert.match(out, new RegExp(MANAGED_START));
});

test("agents: is idempotent", () => {
  const once = renderAgents("# Project\n");
  assert.equal(renderAgents(once), once);
});

test("agents: replaces an old managed block", () => {
  const old = `# Project\n\n${MANAGED_START}\nold\n<!-- ratchet:end -->\n`;
  const next = renderAgents(old);
  assert.doesNotMatch(next, /\nold\n/);
  assert.match(next, /Ratchet workflow/);
});

test("agents: the managed block covers the current lifecycle", () => {
  assert.match(MANAGED, /ratchet amend/);
  assert.match(MANAGED, /ratchet abandon/);
  assert.match(MANAGED, /worktree/i);
  assert.match(MANAGED, /--max-files/);
});

test("syncAgents: writes and reports drift", (t) => {
  const root = temp(t);
  const first = syncAgents(root);
  assert.equal(first.changed, true);
  assert.equal(fs.existsSync(first.file), true);

  const second = syncAgents(root);
  assert.equal(second.changed, false);
  assert.equal(second.next, first.next);

  fs.writeFileSync(first.file, "# changed\n");
  const drift = syncAgents(root, { check: true });
  assert.equal(drift.changed, true);
  assert.equal(fs.readFileSync(first.file, "utf8"), "# changed\n");
});
