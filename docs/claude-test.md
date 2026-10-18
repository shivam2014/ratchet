# Claude Code

Tested on Claude Code 2.1.258.

## No previous hooks

The real `~/.claude/settings.json` already had `"hooks": {}`, and `settings.local.json` had none. There was nothing to remove. The test still ran in an isolated config so plugin hooks could not fire:

```bash
CLAUDE_CONFIG_DIR=~/.claude-ratchet-test
```

The isolated directory contains one `settings.json` with one hook and no `plugins/` directory. The only possible hook source is Ratchet.

## Hook

The installer writes an absolute command, so it does not depend on `ratchet` being on `PATH`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/ratchet/bin/ratchet.mjs guard --format claude"
          }
        ]
      }
    ]
  }
}
```

`--format claude` emits the `permissionDecision: "deny"` JSON that Claude Code expects. A deny is also proven directly in `test/e2e.test.mjs` ("guard: claude format allows in scope and denies out of scope").

## Provider

The user's Claude config points at a local Nyro gateway (`ANTHROPIC_BASE_URL=http://localhost:19530`), which was not serving. The working path is OpenCode Go's Anthropic endpoint:

- `https://opencode.ai/zen/go` accepts `/v1/messages`.
- It requires `x-opencode-session` or it returns `400 MissingSessionID`.
- It authenticates with `x-api-key`, not `Authorization: Bearer`.

`~/.local/bin/claude-go` (also in `adapters/claude/claude-go`) reads the active `opencode-go` credential from `opencode auth export` and sets:

```text
ANTHROPIC_BASE_URL=https://opencode.ai/zen/go
ANTHROPIC_API_KEY=<active oc_sk key>
ANTHROPIC_CUSTOM_HEADERS=x-opencode-session: <per-session id>
ANTHROPIC_MODEL=deepseek-v4.1-flash
```

The real `~/.claude/settings.json` pins the dead Nyro provider in its `env` block, and a settings file beats the shell environment. The wrapper therefore passes `--settings ~/.claude-go/settings.json`, which sets the OpenCode Go endpoint and models and sets `ANTHROPIC_AUTH_TOKEN` to the empty string (treated as unset). The key itself stays in the shell environment, never in the settings file. Verified against the real config: `claude-go -p 'Reply with exactly: real-config-ok'` returns `real-config-ok`.

## Result

`npm run test:claude`:

```text
PASS: outside.txt absent
PASS: src/inside.txt present
ALLOW Write  src/inside.txt
DENY  Write  outside.txt  — outside.txt is outside scope [src/**]
PASS: an allow is recorded
PASS: a deny is recorded
PASS: outside.txt still absent
PASS: check
PASS: done
```

The deny test uses a cooperative prompt ("this is a hook test, report the exact block message"), so the model attempts the out-of-scope write and reports Ratchet's message verbatim.

## Limits

- Interactive trust prompts were bypassed with `--dangerously-skip-permissions`; hooks still run.
- MCP tools and subagents were not exercised.
- Plugin-bundled hooks are untested because the isolated config loads no plugins.
