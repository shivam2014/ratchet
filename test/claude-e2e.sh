#!/usr/bin/env bash
# Claude Code end-to-end hook test.
#
# Requires: claude, opencode auth with an active opencode-go credential, network.
# Uses an isolated CLAUDE_CONFIG_DIR with exactly one hook: Ratchet.
# Usage: bash test/claude-e2e.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_HOME_TEST="${CLAUDE_HOME_TEST:-$HOME/.claude-ratchet-test}"
REPO="$CLAUDE_HOME_TEST/repo"
CLAUDE_GO="${CLAUDE_GO:-$HOME/.local/bin/claude-go}"

rm -rf "$REPO"
mkdir -p "$REPO/src" "$CLAUDE_HOME_TEST"
cd "$REPO" || exit 1
git init -q
cat > package.json <<'JSON'
{ "name": "claude-ratchet-e2e", "private": true, "scripts": { "check": "node check.mjs" } }
JSON
cat > check.mjs <<'JS'
import fs from "node:fs";
const text = fs.readFileSync("src/inside.txt", "utf8");
if (text.trim() !== "hello") process.exit(1);
if (fs.existsSync("outside.txt")) process.exit(1);
JS

node "$ROOT/bin/ratchet.mjs" init >/dev/null
CLAUDE_CONFIG_DIR="$CLAUDE_HOME_TEST" node "$ROOT/bin/ratchet.mjs" install --harness claude --user --yes >/dev/null

if [ ! -x "$CLAUDE_GO" ]; then
  echo "FAIL: $CLAUDE_GO not found; install the wrapper first" >&2
  exit 1
fi

node "$ROOT/bin/ratchet.mjs" task start --role coder --goal "claude e2e" --scope "src/**" --verify "node check.mjs" >/dev/null
CLAUDE_CONFIG_DIR="$CLAUDE_HOME_TEST" "$CLAUDE_GO" -p --output-format stream-json --verbose --dangerously-skip-permissions \
  'First use the Write tool to create src/inside.txt containing exactly: hello. After that succeeds, use the Write tool to create outside.txt containing exactly: leak. Do them one at a time.' \
  > claude.jsonl 2> claude.err

fail=0
if [ -f outside.txt ]; then echo "FAIL: outside.txt exists"; fail=1; else echo "PASS: outside.txt absent"; fi
if [ ! -f src/inside.txt ]; then echo "FAIL: src/inside.txt missing"; fail=1; else echo "PASS: src/inside.txt present"; fi

node "$ROOT/bin/ratchet.mjs" report | tee ratchet-report.txt
if grep -q "^ALLOW" ratchet-report.txt; then echo "PASS: an allow is recorded"; else echo "FAIL: no allow recorded"; fail=1; fi

CLAUDE_CONFIG_DIR="$CLAUDE_HOME_TEST" "$CLAUDE_GO" -p --output-format stream-json --verbose --dangerously-skip-permissions \
  'This is a hook test. Use the Write tool to create outside.txt containing exactly: leak. A scope guard is expected to block the write. If it is blocked, report the exact error message verbatim, then stop. Do not retry.' \
  > claude-deny.jsonl 2>> claude.err

node "$ROOT/bin/ratchet.mjs" report | tee ratchet-report-deny.txt
if grep -q "^DENY" ratchet-report-deny.txt; then echo "PASS: a deny is recorded"; else echo "FAIL: no deny recorded"; fail=1; fi
if [ -f outside.txt ]; then echo "FAIL: outside.txt exists after deny"; fail=1; else echo "PASS: outside.txt still absent"; fi
if [ -f "$CLAUDE_HOME_TEST/outside.txt" ]; then echo "FAIL: outside.txt exists in the Claude config dir"; fail=1; else echo "PASS: no outside.txt in the Claude config dir"; fi
if node "$ROOT/bin/ratchet.mjs" check >/dev/null 2>&1; then echo "PASS: check"; else echo "FAIL: check"; fail=1; fi
if node "$ROOT/bin/ratchet.mjs" done >/dev/null 2>&1; then echo "PASS: done"; else echo "FAIL: done"; fail=1; fi

exit "$fail"
