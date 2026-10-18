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

### OpenCode / T3 Code

```js
export const Ratchet = async ({ directory }) => ({
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

Install with `ratchet sync --install`, which writes `.opencode/plugin/ratchet.js`.

### Claude Code

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|Bash",
        "hooks": [{ "type": "command", "command": "ratchet guard --format claude" }]
      }
    ]
  }
}
```

`--format claude` emits the `PreToolUse` `permissionDecision` JSON and exits 0. Claude reads the deny reason and returns it to the model.

### Cursor

Use the same `PreToolUse` shape as Claude Code, then verify the current Cursor hook config. Cursor also reads `.claude/agents` and `.codex/agents`, so the skill and the contract travel; the hook wiring is the part to check.

### Codex

Assume no portable pre-tool hook. Codex's sandbox and approval mode are the boundary. Ratchet still supplies the contract, the check command, and the CI gate.

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
