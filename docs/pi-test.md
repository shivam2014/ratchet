# pi

Tested on pi 1.3.0.

## Isolation

pi loads extensions in-process, so the test disables every other extension and all context files:

```bash
pi -p --no-session --no-extensions \
  --extension ~/ratchet/adapters/pi/ratchet.ts \
  --no-skills --no-context-files --no-mcp \
  --provider opencode-go --model deepseek-v4.1-flash --api-key "$ACTIVE_KEY" \
  --mode json
```

The active key comes from `opencode auth export` (the `opencode-go` record with `active: true`). The adapter spawns `ratchet` from `~/.local/bin`, which `ratchet install --user` links.

## Adapter

```ts
pi.on("tool_call", async (event, ctx) => {
  const result = spawnSync("ratchet", ["guard"], { input: JSON.stringify(payload), encoding: "utf8", cwd });
  if (result.status === 2) return { block: true, reason: result.stderr.trim() };
});
```

The block returns as a failed tool result; the subagent continues.

## Result

`npm run test:pi`:

```text
PASS: outside.txt absent
PASS: src/inside.txt present
ALLOW write  src/inside.txt
DENY  write  outside.txt  — outside.txt is outside scope [src/**]
PASS: a deny is recorded
PASS: check
PASS: done
```

## Limits

- The orchestrator extension was not loaded. In production, the orchestrator's own `tool_call` handler and the Ratchet adapter must share one policy call, or they will drift.
- MCP tools and extension-spawned subagents were not exercised.
