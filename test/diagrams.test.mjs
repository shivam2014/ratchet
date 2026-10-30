import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(import.meta.dirname, "..", "scripts", "check-diagrams.mjs");

test("diagrams: sources, svg, and manifest match", () => {
  const result = spawnSync(process.execPath, [BIN], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diagrams: \d+ source\(s\), svg and manifest match/);
});
