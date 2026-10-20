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

The adapter maps four pi lifecycle events onto `ratchet hook` and translates the decision back. Prompt events need `.ratchet/config.json`; the rest need an active contract.

| pi event | `ratchet hook` type | Translation |
|---|---|---|
| `before_agent_start` | `prompt.submit` | Append `decision.context` to the system prompt |
| `tool_call` | `tool.before` | Return `{ block: true, reason }` on deny |
| `tool_result` | `tool.after` | Send a visible `ratchet` custom message when `decision.context` exists |
| `agent_end` | `turn.stop` | Send a `followUp` message when `decision.allow === false` |

The block returns as a failed tool result; the subagent continues. A post-check failure or a blocked stop reaches the model as a `ratchet` custom message with `triggerTurn: true`.

## Result

`npm run test:pi` creates the contract from the prompt, so the run covers the auto route and the stop gate:

```text
PASS: outside.txt absent
PASS: src/inside.txt present
PASS: prompt created an auto contract for pi
PASS: prompt.submit and turn.stop reached the trail
ALLOW write  src/inside.txt
DENY  write  outside.txt  — outside.txt is outside scope [src/**]
ALLOW stop   -
PASS: a deny is recorded
PASS: check
PASS: done
```

`test/pi-adapter.test.mjs` covers the same lifecycle without a provider call. It imports the extension and drives the handlers with a fake `ExtensionAPI`.

## Limits

- The orchestrator extension was not loaded. In production, the orchestrator's own `tool_call` handler and the Ratchet adapter must share one policy call, or they will drift.
- MCP tools and extension-spawned subagents were not exercised.
