import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_TRUST_EVENTS,
  findRatchetHooks,
  hookTrustHash,
  hookTrustKey,
  installTrust,
  readTrustHash,
} from "../lib/codex-trust.mjs";

const command = "/usr/local/bin/node /repo/adapters/codex/hook.mjs";

const groups = {
  UserPromptSubmit: {
    hooks: [{ type: "command", command, timeout: 30, statusMessage: "ratchet: injecting contract" }],
  },
  PreToolUse: {
    matcher: "Bash|apply_patch|Edit|Write",
    hooks: [{ type: "command", command, timeout: 30, statusMessage: "ratchet: checking contract" }],
  },
  PostToolUse: {
    matcher: "Bash|apply_patch|Edit|Write",
    hooks: [{ type: "command", command, timeout: 30, statusMessage: "ratchet: recording result" }],
  },
  Stop: {
    hooks: [{ type: "command", command, timeout: 600, statusMessage: "ratchet: verifying" }],
  },
};

function hooksFile(dir) {
  const file = path.join(dir, "hooks.json");
  const hooks = Object.fromEntries(Object.entries(groups).map(([event, group]) => [event, [group]]));
  fs.writeFileSync(file, JSON.stringify({ hooks }));
  return file;
}

test("codex trust hash matches Codex 0.163 for pre_tool_use", () => {
  assert.equal(
    hookTrustHash(groups.PreToolUse, groups.PreToolUse.hooks[0], "PreToolUse"),
    "sha256:4a637e26e2daf00512ba833eeecc7e084d080b054a04a8ababa4891b69d3f318",
  );
});

test("trust keys use the Codex snake_case event name and real indexes", () => {
  const file = path.join(os.tmpdir(), "hooks.json");
  assert.equal(hookTrustKey(file, "UserPromptSubmit", 0, 0), `${file}:user_prompt_submit:0:0`);
  assert.equal(hookTrustKey(file, "PreToolUse", 1, 2), `${file}:pre_tool_use:1:2`);
  assert.equal(hookTrustKey(file, "PostToolUse", 0, 1), `${file}:post_tool_use:0:1`);
  assert.equal(hookTrustKey(file, "Stop", 3, 0), `${file}:stop:3:0`);
});

test("every event has a distinct hash and all four hashes are sha256", () => {
  const hashes = Object.entries(groups).map(([event, group]) => hookTrustHash(group, group.hooks[0], event));
  for (const hash of hashes) assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(new Set(hashes).size, 4);
});

test("installTrust writes, reads, and is idempotent for all four events", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = hooksFile(dir);

  const first = installTrust(dir);
  assert.equal(first.ok, true);
  assert.deepEqual(
    first.entries.map((entry) => entry.event),
    Object.keys(CODEX_TRUST_EVENTS),
  );
  for (const entry of first.entries) assert.equal(readTrustHash(dir, entry.key), entry.trusted);

  const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  for (const eventName of Object.values(CODEX_TRUST_EVENTS)) {
    assert.equal(config.match(new RegExp(`:${eventName}:`, "g")).length, 1, eventName);
  }

  const second = installTrust(dir);
  assert.deepEqual(second.entries, first.entries);

  const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
  hooks.hooks.Stop[0].hooks[0].timeout = 601;
  fs.writeFileSync(file, JSON.stringify(hooks));
  const third = installTrust(dir);
  const changed = third.entries.find((entry) => entry.event === "Stop");
  assert.notEqual(changed.trusted, first.entries.find((entry) => entry.event === "Stop").trusted);
  for (const entry of third.entries.filter((item) => item.event !== "Stop")) {
    assert.equal(entry.trusted, first.entries.find((item) => item.event === entry.event).trusted);
  }
});

test("findRatchetHooks reports every handler with its real group and handler index", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hooks.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo unrelated" }] }],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] },
          { matcher: "Bash", hooks: [{ type: "command", command }, { type: "command", command }] },
        ],
        Stop: [{ hooks: [{ type: "command", command }] }],
      },
    }),
  );

  const found = findRatchetHooks(file);
  assert.deepEqual(
    found.map((hook) => [hook.event, hook.groupIndex, hook.handlerIndex]),
    [
      ["PreToolUse", 1, 0],
      ["PreToolUse", 1, 1],
      ["Stop", 0, 0],
    ],
  );
  const canonical = fs.realpathSync(file);
  assert.equal(found[0].key, `${canonical}:pre_tool_use:1:0`);
  assert.equal(found[1].key, `${canonical}:pre_tool_use:1:1`);
  assert.equal(found[2].key, `${canonical}:stop:0:0`);
});
