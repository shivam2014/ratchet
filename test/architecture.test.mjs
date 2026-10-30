import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { architectureCheck } from "../lib/architecture.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "ratchet.mjs");

function tree(t, files, config = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-arch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) {
    const abs = path.join(dir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  fs.mkdirSync(path.join(dir, ".ratchet"), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(dir, ".ratchet", "config.json"), JSON.stringify(config, null, 2));
  }
  return dir;
}

function ratchet(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

test("architecture: a forbidden import is reported", (t) => {
  const dir = tree(
    t,
    {
      "src/ui/button.ts": 'import { core } from "../core/model";\nexport const button = core;\n',
      "src/core/model.ts": "export const core = 1;\n",
    },
    {
      architecture: {
        forbidden: [{ from: "src/ui/**", to: "src/core/**", reason: "ui must not reach into core internals" }],
      },
    },
  );

  const report = architectureCheck(dir, JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "config.json"), "utf8")));
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1);
  assert.deepEqual(report.violations[0], {
    rule: "forbidden",
    from: "src/ui/button.ts",
    to: "src/core/model.ts",
    reason: "ui must not reach into core internals",
  });
});

test("architecture: an allowed import passes", (t) => {
  const dir = tree(
    t,
    {
      "src/ui/button.ts": 'import { core } from "../lib/model";\nexport const button = core;\n',
      "src/lib/model.ts": "export const core = 1;\n",
    },
    {
      architecture: {
        forbidden: [{ from: "src/ui/**", to: "src/core/**", reason: "ui must not reach into core internals" }],
      },
    },
  );

  const report = architectureCheck(dir, JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "config.json"), "utf8")));
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("architecture: require and export-from edges are scanned", (t) => {
  const dir = tree(
    t,
    {
      "src/ui/a.cjs": 'const core = require("../core/a.cjs");\nmodule.exports = core;\n',
      "src/core/a.cjs": "module.exports = 1;\n",
      "src/ui/b.js": 'export { core } from "../core/a.cjs";\n',
    },
    {
      architecture: {
        forbidden: [{ from: "src/ui/**", to: "src/core/**", reason: "boundary" }],
      },
    },
  );

  const report = architectureCheck(dir, JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "config.json"), "utf8")));
  assert.equal(report.violations.length, 2);
  assert.deepEqual(
    report.violations.map((v) => [v.from, v.to]).sort(),
    [
      ["src/ui/a.cjs", "src/core/a.cjs"],
      ["src/ui/b.js", "src/core/a.cjs"],
    ],
  );
});

test("architecture: an import cycle is caught once", (t) => {
  const dir = tree(
    t,
    {
      "src/a.mjs": 'import "./b.mjs";\nexport const a = 1;\n',
      "src/b.mjs": 'import "./a.mjs";\nexport const b = 1;\n',
    },
    { architecture: { cycles: true } },
  );

  const report = architectureCheck(dir, JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "config.json"), "utf8")));
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].rule, "cycles");
  assert.match(report.violations[0].reason, /src\/a\.mjs -> src\/b\.mjs -> src\/a\.mjs/);
});

test("architecture: cycles are ignored unless enabled", (t) => {
  const dir = tree(
    t,
    {
      "src/a.mjs": 'import "./b.mjs";\nexport const a = 1;\n',
      "src/b.mjs": 'import "./a.mjs";\nexport const b = 1;\n',
    },
    { architecture: { forbidden: [] } },
  );

  const report = architectureCheck(dir, JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "config.json"), "utf8")));
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("architecture: no config is a no-op", (t) => {
  const dir = tree(t, { "src/a.mjs": 'import "./b.mjs";\n', "src/b.mjs": "" });
  const report = architectureCheck(dir, {});
  assert.equal(report.configured, false);
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("architecture CLI: a violation exits 1 and names the next command", (t) => {
  const dir = tree(
    t,
    {
      "src/ui/a.ts": 'import { core } from "../core/a";\n',
      "src/core/a.ts": "export const core = 1;\n",
    },
    {
      architecture: { forbidden: [{ from: "src/ui/**", to: "src/core/**", reason: "boundary" }] },
    },
  );

  const result = ratchet(dir, ["arch"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ARCH/);
  assert.match(result.stdout, /FAIL  forbidden  src\/ui\/a\.ts -> src\/core\/a\.ts/);
  assert.match(result.stdout, /ratchet arch/);

  const json = ratchet(dir, ["arch", "--json"]);
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.violations.length, 1);
});

test("architecture CLI: no rules is a no-op", (t) => {
  const dir = tree(t, { "src/a.mjs": "" });
  const result = ratchet(dir, ["arch"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no architecture rules/);
});

test("architecture: check runs the boundary after verify", (t) => {
  const dir = tree(
    t,
    {
      "src/ui/a.ts": 'import { core } from "../core/a";\n',
      "src/core/a.ts": "export const core = 1;\n",
    },
    {
      checks: [{ id: "noop", cmd: "node -e \"process.exit(0)\"" }],
      architecture: { forbidden: [{ from: "src/ui/**", to: "src/core/**", reason: "boundary" }] },
    },
  );

  const bad = ratchet(dir, ["check"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /PASS  noop/);
  assert.match(bad.stdout, /ARCH/);
  assert.match(bad.stdout, /ratchet check/);

  fs.writeFileSync(path.join(dir, "src", "ui", "a.ts"), 'import { core } from "../../src/lib/a";\n');
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "lib", "a.ts"), "export const core = 1;\n");
  const ok = ratchet(dir, ["check"]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /ARCH  3 file\(s\), 0 violation\(s\)/);
});
