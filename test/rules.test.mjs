import test from "node:test";
import assert from "node:assert/strict";
import { parseRules } from "../lib/rules.mjs";

test("rules: valid row", () => {
  const report = parseRules("rule\tlayer\tenforcer\tproof\nno-any\tlint\teslint\tcommit abc\n");
  assert.equal(report.rows.length, 1);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
});

test("rules: header is ignored", () => {
  const report = parseRules("rule\tlayer\tenforcer\tproof\n");
  assert.equal(report.rows.length, 0);
  assert.equal(report.errors.length, 0);
});

test("rules: prose-only is a warning, not a failure", () => {
  const report = parseRules("style\tprose\tAGENTS.md\t\n");
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /nothing fails/);
});

test("rules: machine layer needs an enforcer and a proof", () => {
  const report = parseRules("floating\tlint\t\t\n");
  assert.equal(report.errors.length, 2);
  assert.match(report.errors.join("\n"), /no enforcing mechanism/);
  assert.match(report.errors.join("\n"), /no proof/);
});

test("rules: unknown layer fails", () => {
  const report = parseRules("x\tvibes\tlint\tcommit\n");
  assert.match(report.errors.join("\n"), /unknown layer/);
});

test("rules: malformed row fails", () => {
  const report = parseRules("only-one-column\n");
  assert.match(report.errors.join("\n"), /expected 4/);
});
