import test from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAny } from "../lib/glob.mjs";

test("glob: ** spans directories", () => {
  assert.equal(globToRegExp("src/**").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/**").test("src/deep/a.ts"), true);
  assert.equal(globToRegExp("src/**").test("lib/a.ts"), false);
});

test("glob: **/ prefix is optional", () => {
  assert.equal(globToRegExp("**/*.ts").test("a.ts"), true);
  assert.equal(globToRegExp("**/*.ts").test("src/a.ts"), true);
  assert.equal(globToRegExp("**/*.ts").test("src/a.js"), false);
});

test("glob: * does not cross directories", () => {
  assert.equal(globToRegExp("src/*.ts").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/*.ts").test("src/deep/a.ts"), false);
});

test("glob: exact and deny patterns", () => {
  assert.equal(matchesAny(".env", [".env"]), true);
  assert.equal(matchesAny("src/.env", ["**/.env"]), true);
  assert.equal(matchesAny("src/.env", [".env"]), false);
});

test("glob: brackets are literal", () => {
  assert.equal(globToRegExp("src/[ab].ts").test("src/[ab].ts"), true);
  assert.equal(globToRegExp("src/[ab].ts").test("src/a.ts"), false);
});
