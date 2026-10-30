import test from "node:test";
import assert from "node:assert/strict";
import { parseCommands } from "../lib/shell-commands.mjs";

test("shell: parses a simple command", () => {
  const { commands, unsupported } = parseCommands("git push --force origin main");
  assert.equal(unsupported, null);
  assert.deepEqual(commands[0].argv, ["git", "push", "--force", "origin", "main"]);
});

test("shell: a quoted argument stays one word", () => {
  const { commands } = parseCommands('git commit -m "remove sudo path"');
  assert.deepEqual(commands[0].argv, ["git", "commit", "-m", "remove sudo path"]);
});

test("shell: a heredoc body is data, not commands", () => {
  const source = "cat > /tmp/test.mjs <<'EOF'\ngit push --force origin main\nEOF";
  const { commands } = parseCommands(source);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].argv, ["cat"]);
  assert.deepEqual(commands[0].redirects, [{ op: ">", target: "/tmp/test.mjs", dup: false }]);
  assert.equal(commands[0].heredocs[0].delimiter, "EOF");
  assert.match(commands[0].heredocs[0].body, /git push --force/);
});

test("shell: a heredoc does not swallow the next command", () => {
  const source = "cat <<EOF\nsudo\nEOF\necho ok";
  const { commands } = parseCommands(source);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].argv, ["cat"]);
  assert.deepEqual(commands[1].argv, ["echo", "ok"]);
});

test("shell: quotes concatenate into one word", () => {
  const { commands } = parseCommands("g''it push --force");
  assert.deepEqual(commands[0].argv, ["git", "push", "--force"]);
});

test("shell: sh -c keeps the script as one word", () => {
  const { commands } = parseCommands("sh -c 'git push --force'");
  assert.deepEqual(commands[0].argv, ["sh", "-c", "git push --force"]);
});

test("shell: splits on operators", () => {
  const { commands } = parseCommands("cd src && git status; echo done");
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].argv, ["cd", "src"]);
  assert.deepEqual(commands[1].argv, ["git", "status"]);
  assert.deepEqual(commands[2].argv, ["echo", "done"]);
});

test("shell: redirects and descriptors", () => {
  const { commands } = parseCommands("npm test > /tmp/out 2>&1");
  assert.deepEqual(commands[0].argv, ["npm", "test"]);
  assert.deepEqual(commands[0].redirects, [
    { op: ">", target: "/tmp/out", dup: false },
    { op: ">&", target: "1", dup: true },
  ]);
});

test("shell: python heredoc keeps the dash operand", () => {
  const { commands } = parseCommands("python3 - <<'PY'\nprint(1)\nPY");
  assert.deepEqual(commands[0].argv, ["python3", "-"]);
  assert.equal(commands[0].heredocs[0].delimiter, "PY");
});

test("shell: comments and line continuation", () => {
  const { commands } = parseCommands("# a comment\necho a\\\nb");
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].argv, ["echo", "ab"]);
});

test("shell: command substitution is captured, not guessed", () => {
  const dollar = parseCommands("echo $(git push --force)");
  assert.equal(dollar.unsupported, null);
  assert.deepEqual(dollar.commands[0].substitutions, ["git push --force"]);

  const backtick = parseCommands("echo `git push --force`");
  assert.deepEqual(backtick.commands[0].substitutions, ["git push --force"]);
});

test("shell: process substitution is unsupported", () => {
  assert.equal(parseCommands("cat <(echo x)").unsupported, "process substitution");
});

test("shell: unterminated quotes are unsupported", () => {
  assert.equal(parseCommands("echo 'unterminated").unsupported, "unterminated quote");
});
