# How Ratchet hooks a harness

Ratchet has one adapter contract: a harness calls `ratchet guard` before a tool runs, and blocks the tool when the CLI exits 2.

The hook is the delivery mechanism. The policy lives in the CLI and the contract on disk, so every harness gets the same rules.

## The seam

```
model
  ↓
harness tool dispatch
  ├── built-in write / edit / bash ──→ adapter hook ──→ ratchet guard ──→ allow / deny
  ├── subagent ─────────────────────→ harness-dependent ──→ may bypass
  └── MCP tool ─────────────────────→ harness-dependent ──→ may bypass
                                              │
                                     git pre-commit ──→ CI required check ──→ merge blocked
```

## Normalized event

The adapter sends one JSON object on stdin:

```json
{
  "harness": "opencode",
  "session_id": "ses_...",
  "agent": "build",
  "tool": "write",
  "input": { "path": "src/a.ts", "content": "..." },
  "cwd": "/repo"
}
```

`tool` is one of `write`, `bash`, `read`, `other`. The adapter maps the harness's names:

| Harness tool | Normalized |
|---|---|
| `write`, `edit`, `patch`, `MultiEdit`, `apply_patch` | `write` |
| `bash`, `shell`, `Bash` | `bash` |
| `read`, `grep`, `glob`, `Read` | `read` |
| everything else | `other` |

## Decision

`ratchet guard` prints:

```json
{ "allow": false, "reason": "lib/a.ts is outside scope [src/**]", "paths": ["lib/a.ts"] }
```

and exits 0 or 2. The adapter turns exit 2 into the harness's block primitive.

## Per-harness wiring

### pi

```ts
pi.on("tool_call", async (event, ctx) => {
  const result = spawnSync("ratchet", ["guard"], {
    input: JSON.stringify({ harness: "pi", tool: event.toolName, input: event.input, cwd: ctx.cwd }),
    encoding: "utf8",
  });
  if (result.status === 2) return { block: true, reason: result.stderr.trim() };
});
```

If the pi orchestrator extension is loaded, do not add this as a second independent handler. Call the same `decide()` from inside the orchestrator's existing `tool_call` handler. Two guards with two contracts is how drift starts.

### OpenCode 1.x / T3 Code on 1.x

On OpenCode 1.x only, the plugin is a default-exported function returning named hooks. The installer writes this shape to `ratchet-v1.js` when the detected major version is below 2.

```js
export const RatchetV1 = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    const result = spawnSync("ratchet", ["guard"], {
      input: JSON.stringify({ harness: "opencode", tool: input.tool, input: output.args, cwd: directory }),
      encoding: "utf8",
    });
    if (result.status === 2) throw new Error(result.stderr.trim());
  },
});
```

OpenCode turns a thrown error into a failed tool call and shows the message to the model.

Install with `ratchet sync --install`, or `ratchet install --harness opencode --project --yes`, which writes `.opencode/plugins/ratchet.js` using the adapter for the detected major version.

### Claude Code

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|Bash",
        "hooks": [
          { "type": "command", "command": "/path/to/node /path/to/ratchet/adapters/claude/hook.mjs" }
        ]
      }
    ]
  }
}
```

The adapter no-ops outside a repo with `.ratchet/current`, so a user-level install never touches unrelated projects. Inside a contract it forwards the raw hook JSON to `ratchet guard --format claude` and passes the deny decision through.

### Cursor

Use the same `PreToolUse` shape as Claude Code, then verify the current Cursor hook config. Cursor also reads `.claude/agents` and `.codex/agents`, so the skill and the contract travel; the hook wiring is the part to check.

### OpenCode

OpenCode 2.x replaced the v1 hook object with a default definition and a `setup` function:

```js
export default {
  id: "ratchet",
  setup: async (ctx) => {
    await ctx.tool.hook("execute.before", (event) => {
      // event.tool, event.id, event.input
      if (blocked) throw new Error("reason");
    });
    return () => {};
  },
};
```

The installer detects the OpenCode major version and writes the v2 file (`ratchet.js`) or the v1 file (`ratchet-v1.js`). A v1 plugin on a v2 runtime is skipped with a warning and no error, so the harness looks normal while the policy is off. Check for the plugin in the server log after any OpenCode upgrade.

`ctx.directory` is undefined on 2.0. Use `ctx.location.directory`.

### Codex

Codex 0.163 supports lifecycle hooks for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. `PreToolUse` covers `Bash`, `apply_patch`, MCP tools, and other local function tools. Hosted tools such as web search do not use the hook path. Hooks require a trust review, or `--dangerously-bypass-hook-trust` for automation.

`~/.codex/hooks.json` holds one Ratchet handler per event, each in its own group:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/ratchet/adapters/codex/hook.mjs",
            "timeout": 30,
            "statusMessage": "ratchet: injecting contract"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/ratchet/adapters/codex/hook.mjs",
            "timeout": 30,
            "statusMessage": "ratchet: checking contract"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|apply_patch|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/ratchet/adapters/codex/hook.mjs",
            "timeout": 30,
            "statusMessage": "ratchet: recording result"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/ratchet/adapters/codex/hook.mjs",
            "timeout": 600,
            "statusMessage": "ratchet: verifying"
          }
        ]
      }
    ]
  }
}
```

`ratchet install --harness codex --user` writes all four groups and one trust entry per handler in `~/.codex/config.toml`, under `[hooks.state."<hooks.json>:<event_name>:<group>:<handler>"]`. Event names are `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, and `stop`. The hash algorithm in `lib/codex-trust.mjs` is verified against Codex 0.163 for all four events. If a hash stops matching after an upgrade, the hook stays untrusted rather than silently allowing writes. Run `/hooks` in the TUI to trust it again, or `node adapters/codex/trust.mjs` to recompute.

`ratchet doctor --harness codex` checks that all four hooks are present, each command is exact, every trust hash matches, and the adapter no-ops outside a contract.

The adapter maps `Bash` to `bash` with `{command}`, `apply_patch` to `write` with `{patch}`, and `Edit`/`Write` to `write` with `{path}`. Prompt events need `.ratchet/config.json`; tool and stop events need `.ratchet/current`. Outside those, every event exits 0 with no output. The responses are `hookSpecificOutput.additionalContext` for prompts, the deny JSON below for `PreToolUse`, nothing for `PostToolUse`, and `{"decision":"block","reason":...}` for `Stop`.

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "[ratchet] outside.txt is outside scope [src/**]"
  }
}
```

### Git and CI

- `.git/hooks/pre-commit` runs `ratchet check`. Local feedback.
- CI runs `ratchet check` and is marked required in branch protection. Authoritative.

## What the hook can see

Sees:

- the tool name and arguments,
- the cwd and session id,
- the agent id when the harness provides one.

Does not see:

- the full system prompt,
- the model's prose,
- an MCP tool call the harness does not route through the hook,
- a subagent call the harness does not route through the hook.

## What the hook cannot stop

A hook is policy, not a boundary. A harness can:

- disable or edit the plugin,
- call an MCP tool that writes,
- spawn a subagent whose calls bypass the hook ([opencode #5894](https://github.com/sst/opencode/issues/5894)),
- use `git commit --no-verify`,
- edit `.ratchet/contract.json` if it has write access.

That is why the authoritative layers are outside the harness:

| Layer | Stops |
|---|---|
| Sandbox / container | Writes outside the mounted paths |
| Read-only checkout | Any write for a read-only role |
| Separate OS user | Writes to another user's files |
| Server-side branch protection | Merging without the required check |
| CODEOWNERS | Self-merging sensitive paths |
| CI required check | Landing a change the check rejects |

Ratchet makes the cheap path correct. The environment makes the wrong path impossible.

## Test one adapter without a harness

```bash
printf '%s' '{"harness":"test","tool":"write","input":{"path":"lib/a.ts"},"cwd":"/repo"}' \
  | ratchet guard
echo "exit=$?"
```

A correct block prints the reason on stderr and exits 2. If it exits 0, the adapter is sending the wrong tool name or the contract scope is too wide.

## Health check

`ratchet doctor` reports whether the contract, checks, and OpenCode adapter exist. Add one line per adapter you install.
