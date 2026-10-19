# OpenCode and T3 Code

> Historical: this records the OpenCode 2.0 runtime path. T3 Code is now its own harness; see [vision.md](vision.md) and [universal-integration.md](universal-integration.md) for the current T3 integration paths.

Tested on OpenCode 2.0.32 (the runtime T3 Code used at the time).

## The 2.0 plugin API rewrite

OpenCode 1.x loaded a module whose default export was a function returning named hooks:

```js
export const Ratchet = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => { ... },
});
```

OpenCode 2.x rejects that shape:

```text
Plugin must export a default definition with an id and an effect or setup function.
```

`tool.execute.before` and the other 1.x hook names are gone. The 2.x contract is a default definition with an `id` and a `setup` function that registers hooks against domains:

```js
export default {
  id: "ratchet",
  setup: async (ctx) => {
    await ctx.tool.hook("execute.before", (event) => {
      // event.tool, event.id, event.input
      throw new Error("blocked");
    });
  },
};
```

Two consequences:

1. A 1.x plugin does not fail loudly. It is skipped with a warning, and the session looks normal. The first OpenCode test proved this: `outside.txt` was created and Ratchet recorded zero events because the old adapter never loaded.
2. `ctx.directory` is undefined in 2.0. The working path is `ctx.location.directory`.

Ratchet's installer detects the OpenCode major version and writes `ratchet.js` (v2) or `ratchet-v1.js` (v1). The v2 event shape used by the test:

```json
{
  "tool": "write",
  "sessionID": "ses_...",
  "agent": "build",
  "id": "call_...",
  "input": { "path": "/repo/src/inside.txt", "content": "hello\n" }
}
```

## Result

`npm run test:opencode`:

```text
PASS: outside.txt absent
PASS: src/inside.txt present
ALLOW write  src/inside.txt
DENY  write  outside.txt  — outside.txt is outside scope [src/**]
PASS: an allow is recorded
PASS: a deny is recorded
PASS: check
PASS: done
```

## Limits

- The plugin hook covers built-in tools. MCP tools and subagent calls may bypass it; CI remains the authority.
- At the time, T3 Code used the same OpenCode runtime, so the same plugin applied. T3's own MCP tools were not covered. T3 is now its own harness; see [vision.md](vision.md) for the current paths.
- The user's global `@warp-dot-dev/opencode-warp` plugin fails to load under 2.0 for the same v1-shape reason. That is unrelated to Ratchet, but it is why the plugin-load warning appears in any 2.0 log.
