/**
 * CLI stress matrix. Drives the real `ratchet hook` and `ratchet guard`
 * commands against a temp repo. Complements `npm test`, which does not spawn
 * the CLI for every path.
 *
 * Run: npm run test:stress
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createContract, saveContract } from "../lib/contract.mjs";
import { canLinkDir, linkDir, outsideDir } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "ratchet.mjs");
const dirs = [];
const rows = [];

function check(name, ok, detail = "") {
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

/**
 * A case whose primitive does not exist on this host. It counts as neither a
 * pass nor a failure, so the POSIX case count is unchanged and Windows does
 * not pretend to have proved something it could not run.
 */
function skip(name, detail = "") {
  rows.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? "  " + detail : ""}`);
}

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function repo() {
  const root = temp("ratchet-stress-");
  spawnSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "stress", scripts: { check: "node check.mjs" } }));
  fs.writeFileSync(path.join(root, "check.mjs"), 'import fs from "node:fs";\nprocess.exit(fs.existsSync("PASS_MARKER") ? 0 : 1);\n');
  return root;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

function hook(cwd, payload, raw) {
  const input = raw === undefined ? JSON.stringify(payload) : raw;
  const r = spawnSync(process.execPath, [BIN, "hook"], { cwd, input, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json: json ?? {}, stderr: r.stderr };
}

function hookAsync(cwd, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "hook"], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      let json = {};
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, json, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

process.on("exit", () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const T = repo();
run(T, ["init"]);
run(T, ["task", "start", "--force", "--role", "coder", "--goal", "stress", "--scope", "src/**", "--verify", "node check.mjs"]);

function before(tool, input, session = "s1") {
  return hook(T, { type: "tool.before", harness: "stress", session_id: session, cwd: T, tool, input });
}

let r = hook(T, null, "");
check("empty stdin rejected", r.code === 1 && /expects a JSON event/.test(r.stderr), `code=${r.code}`);
r = hook(T, null, "{");
check("invalid JSON rejected", r.code === 1 && /not valid JSON/.test(r.stderr), `code=${r.code}`);
r = hook(T, { type: "nope" });
check("unknown type rejected", r.code === 2 && /valid types/.test(r.stderr), `code=${r.code}`);
r = hook(T, { type: "turn.stop", version: 2, harness: "t", session_id: "s" });
check("unsupported version rejected", r.code === 2 && /not supported/.test(r.stderr), `code=${r.code}`);
r = hook(T, { type: "tool.before", harness: "t", session_id: "s" });
check("missing required field rejected", r.code === 2 && /needs "tool"/.test(r.stderr), `code=${r.code}`);

const T2 = repo();
r = hook(T2, { type: "tool.before", harness: "t", session_id: "s", tool: "write", input: { path: "a.ts" } });
check("no contract: write denied", r.code === 2 && r.json.allow === false, `code=${r.code}`);
r = hook(T2, { type: "tool.before", harness: "t", session_id: "s", tool: "read", input: { path: "a.ts" } });
check("no contract: read allowed", r.code === 0 && r.json.allow === true, `code=${r.code}`);
r = hook(T2, { type: "turn.stop", harness: "t", session_id: "s" });
check("no contract: stop uncertified allow", r.code === 0 && r.json.allow === true && r.json.certified === false, `code=${r.code}`);
r = hook(T2, { type: "prompt.submit", harness: "t", session_id: "s", prompt: "hi" });
check("no contract: prompt context null", r.code === 0 && r.json.context === null, `code=${r.code}`);
r = run(T2, ["done"]);
check("done without a contract refuses", r.status === 1 && /No active task contract/.test(r.stderr), `code=${r.status}`);

r = before("write", { path: "src/a.ts" });
check("in-scope write allowed", r.code === 0 && r.json.allow === true, `code=${r.code}`);
r = before("write", { path: "lib/a.ts" });
check("out-of-scope write denied", r.code === 2 && r.json.allow === false, `code=${r.code}`);
r = before("write", { path: "src/../lib/a.ts" });
check("path traversal denied", r.code === 2 && r.json.allow === false, `code=${r.code}`);
r = before("write", { content: "x" });
check("write without path denied", r.code === 2, `code=${r.code}`);
r = before("bash", { command: "rm -rf /" });
check("bash hard deny", r.code === 2 && /hard rule/.test(r.json.reason ?? ""), `code=${r.code}`);
r = before("bash", { command: "npm install" });
check("unresolved bash allowed and marked", r.code === 0 && r.json.allow === true, `code=${r.code}`);

run(T, ["task", "start", "--force", "--role", "reviewer", "--goal", "read only", "--scope", "src/**", "--verify", "node check.mjs"]);
r = before("write", { path: "src/ro.ts" });
check("read-only contract blocks writes", r.code === 2 && /read-only/.test(r.json.reason ?? ""), `code=${r.code}`);

run(T, ["task", "start", "--force", "--role", "coder", "--goal", "gate", "--scope", "src/**", "--pstack", "--verify", "node check.mjs"]);
r = before("write", { path: "src/gate.ts" });
check("skill gate blocks source", r.code === 2 && /Skill gate/.test(r.json.reason ?? ""), `code=${r.code}`);
r = before("write", { path: ".ratchet/plan.md" });
check("gate artifact stays writable", r.code === 0, `code=${r.code}`);

run(T, ["task", "start", "--force", "--role", "coder", "--goal", "deny", "--scope", "**", "--verify", "node check.mjs"]);
r = before("write", { path: ".env" });
check("denied path .env", r.code === 2, `code=${r.code}`);

r = before("write", { path: ".ENV" });
const caseAllowed = r.code === 0;
check("case-folded .ENV denied", !caseAllowed, caseAllowed ? "ALLOWED" : `code=${r.code}`);
if (caseAllowed) {
  fs.writeFileSync(path.join(T, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(T, ".ENV"), "LEAK=1\n");
  const landed = fs.readFileSync(path.join(T, ".env"), "utf8").includes("LEAK=1");
  check("case bypass does not reach .env", !landed, landed ? ".env overwritten via .ENV" : ".ENV is a separate file");
}

run(T, ["task", "start", "--force", "--role", "coder", "--goal", "budget", "--scope", "**", "--max-files", "1", "--max-writes", "2", "--verify", "node check.mjs"]);
r = before("write", { path: "src/b.ts" });
const budgetFirst = r.code === 0;
r = before("write", { path: "src/c.ts" });
check("file budget enforced", budgetFirst && r.code === 2 && /budget/i.test(r.json.reason ?? ""), `code=${r.code}`);

run(T, ["task", "start", "--force", "--role", "coder", "--goal", "stop", "--scope", "**", "--verify", "node check.mjs"]);
const stop = () => hook(T, { type: "turn.stop", harness: "stress", session_id: "s1", cwd: T });
r = stop();
check("failing check blocks", r.code === 2 && r.json.allow === false && /checks failed/.test(r.json.reason ?? ""), `code=${r.code}`);
fs.writeFileSync(path.join(T, "PASS_MARKER"), "");
r = stop();
check("passing check certifies", r.code === 0 && r.json.certified === true, `code=${r.code}`);

fs.writeFileSync(
  path.join(T, "package.json"),
  JSON.stringify({ name: "stress", scripts: { check: 'node -e "process.exit(0)"' } }),
);
r = stop();
check("check surface tamper blocks", r.code === 2 && /check surface changed/.test(r.json.reason ?? ""), `code=${r.code}`);

run(T, ["disable", "--reason", "stress"]);
r = run(T, ["status"]);
check("status reports disabled", r.status === 0 && /DISABLED/.test(r.stdout), `code=${r.status}`);
r = before("write", { path: ".env" });
check("kill switch allows with reason", r.code === 0 && /disabled/.test(r.json.reason ?? ""), `code=${r.code}`);
run(T, ["enable"]);
r = before("write", { path: ".env" });
check("kill switch off restores deny", r.code === 2, `code=${r.code}`);

if (!canLinkDir()) {
  skip("symlink escape denied", "directory links are not permitted on this host");
} else {
  const outside = outsideDir(null, "stress-outside-");
  fs.mkdirSync(path.join(T, "src"), { recursive: true });
  linkDir(outside, path.join(T, "src", "out"));
  run(T, ["task", "start", "--force", "--role", "coder", "--goal", "symlink", "--scope", "src/**", "--verify", "node check.mjs"]);
  r = before("write", { path: "src/out/leak.txt" });
  const symlinkAllowed = r.code === 0;
  if (symlinkAllowed) fs.writeFileSync(path.join(T, "src/out/leak.txt"), "leak\n");
  const escaped = fs.existsSync(path.join(outside, "leak.txt"));
  check("symlink escape denied", !symlinkAllowed || !escaped, symlinkAllowed ? `ALLOWED, wrote ${outside}/leak.txt` : `code=${r.code}`);
}

const a = createContract(T, { goal: "session a", role: "coder", scope: ["src/**"] });
a.session_id = "session-A";
saveContract(T, a);
const b = createContract(T, { goal: "session b", role: "coder", scope: ["lib/**"] });
b.session_id = "session-B";
saveContract(T, b);

r = before("write", { path: "lib/b.ts" }, "session-A");
const aDenied = r.code === 2;
r = before("write", { path: "lib/b.ts" }, "session-B");
const bAllowed = r.code === 0;
check("each session uses its own contract", aDenied && bAllowed, `A=${aDenied} B=${bAllowed}`);

const write = (session, target) => ({
  type: "tool.before",
  harness: "stress",
  session_id: session,
  cwd: T,
  tool: "write",
  input: { path: target },
});
const [aOk, bOk, aBad, bBad] = await Promise.all([
  hookAsync(T, write("session-A", "src/a.ts")),
  hookAsync(T, write("session-B", "lib/b.ts")),
  hookAsync(T, write("session-A", "lib/a.ts")),
  hookAsync(T, write("session-B", "src/b.ts")),
]);
check(
  "concurrent sessions keep their own scope",
  aOk.code === 0 && bOk.code === 0 && aBad.code === 2 && bBad.code === 2,
  `A=${aOk.code}/${aBad.code} B=${bOk.code}/${bBad.code}`,
);

const T3 = repo();
run(T3, ["init"]);
r = run(T3, ["install", "--harness", "t3", "--project", "--yes"]);
const installed = fs.existsSync(path.join(T3, ".opencode/plugins/ratchet.js"));
r = run(T3, ["uninstall", "--harness", "t3", "--project"]);
const removed = !fs.existsSync(path.join(T3, ".opencode/plugins/ratchet.js"));
check("t3 plugin installs and uninstalls", installed && removed, `installed=${installed} removed=${removed}`);

const failures = rows.filter((row) => !row.ok);
const skips = rows.filter((row) => row.skipped).length;
console.log(`\nsummary pass=${rows.length - failures.length - skips} fail=${failures.length} skip=${skips}`);
process.exit(failures.length ? 1 : 0);
