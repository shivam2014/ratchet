import test from "node:test";
import assert from "node:assert/strict";
import { classifyBash } from "../lib/classify.mjs";

test("classify: plain reads are not writes", () => {
  const r = classifyBash("cat src/a.ts | grep foo");
  assert.equal(r.write, false);
  assert.deepEqual(r.paths, []);
});

test("classify: redirect target is a write", () => {
  const r = classifyBash("echo hi > src/a.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.ts"]);
});

test("classify: rm names its operands", () => {
  const r = classifyBash("rm -f src/a.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.ts"]);
});

test("classify: sed -i is a write", () => {
  const r = classifyBash("sed -i 's/a/b/' src/a.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.ts"]);
});

test("classify: cp only checks the destination", () => {
  const r = classifyBash("cp src/a.ts src/b.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/b.ts"]);
});

test("classify: hard deny wins", () => {
  assert.equal(classifyBash("rm -rf /").hardDeny, true);
  assert.equal(classifyBash("rm -rf ~").hardDeny, true);
  assert.equal(classifyBash("rm -rf /tmp/scratch").hardDeny, false);
  assert.equal(classifyBash("git push --force origin main").hardDeny, true);
  assert.equal(classifyBash("git push --force-with-lease origin main").hardDeny, false);
  assert.equal(classifyBash("git reset --hard HEAD~1").hardDeny, true);
});

test("classify: npm install is a mutation with no resolved path", () => {
  const r = classifyBash("npm install");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, []);
});
