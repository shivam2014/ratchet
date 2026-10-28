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

test("classify: append redirect is a write", () => {
  const r = classifyBash("echo hi >> src/a.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.ts"]);
});

test("classify: stderr redirect is not a file mutation", () => {
  const r = classifyBash("echo hi 2>/dev/null");
  assert.equal(r.write, false);
  assert.deepEqual(r.paths, []);
});

test("classify: tee names its target", () => {
  const r = classifyBash("echo hi | tee src/a.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.ts"]);
});

test("classify: git add names its paths", () => {
  const r = classifyBash("git add src/a.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.ts"]);
});

test("classify: git -C resolves the path against the directory", () => {
  const r = classifyBash("git -C src add a.ts");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.ts"]);
});

test("classify: git commit is a mutation with no file operand", () => {
  const r = classifyBash('git commit -m "fix"');
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, []);
});

test("classify: apply_patch heredoc names its files", () => {
  const command = [
    "apply_patch <<'PATCH'",
    "*** Begin Patch",
    "*** Add File: src/a.txt",
    "+hello",
    "*** Add File: outside.txt",
    "+leak",
    "*** End Patch",
    "PATCH",
  ].join("\n");
  const r = classifyBash(command);
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.txt", "outside.txt"]);
});

test("classify: git apply heredoc names its files", () => {
  const command = [
    "git apply <<'PATCH'",
    "diff --git a/src/a.txt b/src/a.txt",
    "--- a/src/a.txt",
    "+++ b/src/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "PATCH",
  ].join("\n");
  const r = classifyBash(command);
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["src/a.txt"]);
});

test("classify: git diff stays a read", () => {
  const r = classifyBash("git diff HEAD~1");
  assert.equal(r.write, false);
  assert.deepEqual(r.paths, []);
});

test("classify: inline interpreter code is write-class and unresolved", () => {
  const r = classifyBash('node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"');
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, []);
});

test("classify: a heredoc payload is inline, not a read", () => {
  for (const command of [
    "python3 - <<'EOF'\nopen('src/x','w').write('x')\nEOF",
    "python3 <<EOF\nprint(1)\nEOF",
    "node <<'EOF'\nrequire('fs').writeFileSync('src/x','x')\nEOF",
    "bash <<'EOF'\necho x > src/x\nEOF",
    "perl - <<'EOF'\nopen F, '>src/x'\nEOF",
  ]) {
    const r = classifyBash(command);
    assert.equal(r.inline, true, command.split("\n")[0]);
    assert.equal(r.write, true, command.split("\n")[0]);
  }
});

test("classify: other inline entry points are write-class", () => {
  for (const command of [
    'bun -e \'await Bun.write("src/x","x")\'',
    'deno eval \'Deno.writeTextFileSync("src/x","x")\'',
    'php -r \'file_put_contents("src/x","x");\'',
    'sh -s <<EOF\necho x > src/x\nEOF',
    'python3 - < script.py',
  ]) {
    const r = classifyBash(command);
    assert.equal(r.inline, true, command);
    assert.equal(r.write, true, command);
  }
});

test("classify: a script file is not inline", () => {
  for (const command of ["node script.mjs", "python3 tools/x.py", "bash test/e2e.sh", "bun run test"]) {
    const r = classifyBash(command);
    assert.equal(r.inline, false, command);
  }
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
