#!/usr/bin/env bash
# Codex end-to-end hook test.
#
# Requires: codex, opencode auth with an active opencode-go credential, network.
# Usage: bash test/codex-e2e.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_HOME_TEST="${CODEX_HOME_TEST:-$HOME/.codex-ratchet-test}"
REPO="$CODEX_HOME_TEST/repo"
CODEX_GO="${CODEX_GO:-$HOME/.local/bin/codex-go}"

rm -rf "$REPO"
mkdir -p "$REPO/src"
cd "$REPO" || exit 1
git init -q
cat > package.json <<'JSON'
{ "name": "codex-ratchet-e2e", "private": true, "scripts": { "check": "node check.mjs" } }
JSON
cat > check.mjs <<'JS'
import fs from "node:fs";
const text = fs.readFileSync("src/inside.txt", "utf8");
if (text.trim().replace(/\.$/, "") !== "hello") process.exit(1);
if (fs.existsSync("outside.txt")) process.exit(1);
JS

node "$ROOT/bin/ratchet.mjs" init >/dev/null
node "$ROOT/bin/ratchet.mjs" task start --role coder --goal "codex e2e" --scope "src/**" --verify "node check.mjs" >/dev/null

if [ ! -x "$CODEX_GO" ]; then
  echo "FAIL: $CODEX_GO not found; install the wrapper first" >&2
  exit 1
fi

run_codex() {
  CODEX_HOME="$CODEX_HOME_TEST" "$CODEX_GO" exec --json \
    --sandbox workspace-write --dangerously-bypass-hook-trust -C "$REPO" -o last.txt \
    'Use apply_patch to create src/inside.txt containing exactly: hello. Do not create any other file.' \
    > codex.jsonl 2> codex.err
}

run_codex
if [ ! -f src/inside.txt ] && grep -q "429" codex.jsonl; then
  echo "retry: provider rate limited"
  sleep 20
  run_codex
fi

fail=0
if [ -f outside.txt ]; then echo "FAIL: outside.txt exists"; fail=1; else echo "PASS: outside.txt absent"; fi
if [ ! -f src/inside.txt ]; then echo "FAIL: src/inside.txt missing"; fail=1; else echo "PASS: src/inside.txt present"; fi

# The model call above proves Codex loads the hook and allows an in-scope write.
# Drive the installed hook directly for the deny, so a provider rate limit on a
# second model turn cannot hide the decision.
HOOK_CMD=$(node -e '
const fs = require("fs");
const hooks = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const handler = (hooks.hooks?.PreToolUse ?? [])
  .flatMap((group) => group.hooks ?? [])
  .find((entry) => typeof entry.command === "string" && entry.command.includes("ratchet"));
if (handler) process.stdout.write(handler.command);
' "$CODEX_HOME_TEST/hooks.json")

if [ -z "$HOOK_CMD" ]; then
  echo "FAIL: no installed Codex hook"
  fail=1
else
  printf '%s' "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"codex-e2e-deny\",\"cwd\":\"$REPO\",\"tool_name\":\"apply_patch\",\"tool_input\":{\"command\":\"*** Begin Patch\\n*** Add File: outside.txt\\n+leak\\n*** End Patch\"}}" \
    | sh -c "$HOOK_CMD" > codex-deny.json 2> codex-deny.err
  if node -e 'const fs = require("fs"); const j = JSON.parse(fs.readFileSync("codex-deny.json", "utf8")); process.exit(j.hookSpecificOutput?.permissionDecision === "deny" ? 0 : 1);' 2>/dev/null; then
    echo "PASS: installed hook denies outside.txt"
  else
    echo "FAIL: installed hook did not deny outside.txt"
    fail=1
  fi
fi

node "$ROOT/bin/ratchet.mjs" report | tee ratchet-report.txt
if grep -q "^DENY" ratchet-report.txt; then echo "PASS: a deny is recorded"; else echo "FAIL: no deny recorded"; fail=1; fi
if node "$ROOT/bin/ratchet.mjs" check >/dev/null 2>&1; then echo "PASS: check"; else echo "FAIL: check"; fail=1; fi
if node "$ROOT/bin/ratchet.mjs" done >/dev/null 2>&1; then echo "PASS: done"; else echo "FAIL: done"; fail=1; fi

exit "$fail"
