#!/bin/sh
# Claude Code PreToolUse hook. Reads the hook JSON on stdin.
BIN="${RATCHET_BIN:-$HOME/.local/bin/ratchet}"
[ -x "$BIN" ] || BIN=ratchet
exec "$BIN" guard --format claude
