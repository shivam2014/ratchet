#!/bin/sh
# Claude Code PreToolUse hook. Reads the hook JSON on stdin.
# Delegates to the Node adapter, which no-ops outside a Ratchet contract.
exec node "$(dirname "$0")/hook.mjs"
