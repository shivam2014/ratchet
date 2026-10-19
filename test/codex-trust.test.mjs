import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookTrustHash, installTrust, readTrustHash } from "../lib/codex-trust.mjs";

const command = "/Users/shivam94/.hermes/node/bin/node /Users/shivam94/ratchet/adapters/codex/hook.mjs";
const group = {
  matcher: "Bash|apply_patch|Edit|Write",
  hooks: [{ type: "command", command, timeout: 30, statusMessage: "ratchet: checking contract" }],
};

test("codex trust hash matches Codex 0.163", () => {
  assert.equal(
    hookTrustHash(group, group.hooks[0]),
    "sha256:e0600d2f17883566bd6b84f9add4943dd2306dbdab5a8bb69a84d8be9e729b93",
  );
});

test("installTrust writes, reads, and is idempotent", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [group] } }));

  const first = installTrust(dir);
  assert.equal(first.ok, true);
  assert.equal(readTrustHash(dir), first.trusted);

  const second = installTrust(dir);
  assert.equal(second.trusted, first.trusted);
  const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  assert.equal(config.match(/pre_tool_use:0:0/g).length, 1);
});
