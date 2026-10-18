#!/usr/bin/env bash
# End-to-end proof: contract -> guard -> check -> done, including a real block.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RATCHET=(node "$ROOT/bin/ratchet.mjs")
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

cd "$DIR"
git init -q
mkdir -p src
cat > package.json <<'JSON'
{ "name": "demo", "scripts": { "check": "node check.mjs" } }
JSON
cat > check.mjs <<'JS'
import fs from "node:fs";
const text = fs.readFileSync("src/hello.txt", "utf8");
if (text.trim() !== "hello") {
  console.error("expected src/hello.txt to contain hello");
  process.exit(1);
}
console.log("src/hello.txt contains hello");
JS

echo "$ ratchet init"
"${RATCHET[@]}" init
echo
echo "$ ratchet task start ..."
"${RATCHET[@]}" task start --role coder --goal "add hello file" --scope "src/**"
echo
echo "$ guard: write src/hello.txt (allowed)"
printf '%s' '{"harness":"demo","tool":"write","input":{"path":"src/hello.txt"},"cwd":"'"$DIR"'"}' \
  | "${RATCHET[@]}" guard
echo
echo "$ guard: write lib/leak.txt (blocked)"
printf '%s' '{"harness":"demo","tool":"write","input":{"path":"lib/leak.txt"},"cwd":"'"$DIR"'"}' \
  | "${RATCHET[@]}" guard
echo "exit=$?"
echo
printf 'hello\n' > src/hello.txt
echo "$ ratchet check"
"${RATCHET[@]}" check
echo
echo "$ ratchet done"
"${RATCHET[@]}" done
