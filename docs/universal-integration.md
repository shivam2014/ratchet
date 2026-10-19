# Universal integration: how Ratchet drives every harness

**Status:** architecture note, 2026-10-20
**Question:** the pi orchestrator gets its power from internal pi hooks: `before_agent_start` for guidance, `tool_call` for scope, `tool_result` for lint feedback, and `agent_end`/`sendMessage` for continuation. How does a portable Ratchet get the same integration with Codex, Claude Code, T3/OpenCode, Cursor, and future harnesses without those internals?

## Short answer

No model is required to drive enforcement. In fact, a model must **not** be the thing that decides whether checks run: that is self-invigilation.

The portable layer is a **normalized lifecycle protocol** plus **thin adapters**:

```text
native harness event
      ↓  adapter (per harness)
normalized event (JSON)
      ↓  CLI / policy engine
decision (context, allow/deny, continue/stop, evidence)
      ↓  adapter
native response (additionalContext, block, follow-up, exit code)
```

The pi extension is one adapter. Its policy moves into the core; its `before_agent_start`, `tool_call`, `tool_result`, and `agent_end` handlers become one implementation of the protocol. The core never imports pi.

The broadest implementation of that protocol is an **ACP proxy**: one wrapper between any ACP editor and any ACP agent. The deepest implementation is **native hooks**: Codex, Claude, Cursor, pi. Use ACP for breadth and native hooks for depth.

A model can be an **outer supervisor** for harnesses with no lifecycle API: it launches the harness, watches the workspace, runs Ratchet checks, and sends failures back. That is a valid fallback. It is not the trust boundary, because the checks are still deterministic and outside the model.

## What pi actually depends on

Every pi mechanism has a generic equivalent:

| pi mechanism | Generic lifecycle point | Codex | Claude Code | Cursor | OpenCode | T3 |
|---|---|---|---|---|---|---|
| `before_agent_start` returns a system prompt | `prompt.submit` / `context.inject` | `UserPromptSubmit` + `additionalContext` | `UserPromptSubmit` + `additionalContext` | `beforeSubmitPrompt` | plugin chat/system hooks (verify v2) | message preamble + provider prompt |
| `tool_call` blocks a tool | `tool.before` | `PreToolUse` | `PreToolUse` | `preToolUse` | `tool.execute.before` | underlying provider hook; T3 MCP has no pre-tool veto |
| `tool_result` observes a result | `tool.after` | `PostToolUse` | `PostToolUse` | `postToolUse`, `afterFileEdit` | `tool.execute.after` | thread activity via MCP |
| `agent_end` + `sendMessage` forces a turn | `turn.stop` | `Stop` with `decision: "block"` | `Stop` exit 2 | `stop` with `followup_message` | session idle + client prompt (soft) | `t3_thread_wait` + `t3_thread_send` |
| TUI activity feed | renderer | CLI/JSON | CLI/JSON | CLI/JSON | CLI/JSON | T3 timeline + CLI/JSON |

The important part is not the names. It is that the same four decisions exist everywhere: what context to inject, whether to allow a tool, what to do after a tool, and whether the turn may end.

## The normalized protocol

Ratchet should define one small event/decision schema and keep it stable.

### Events

```json
{"type":"session.start","harness":"codex","session_id":"…","cwd":"/repo"}
{"type":"prompt.submit","harness":"claude","session_id":"…","prompt":"…","cwd":"/repo"}
{"type":"tool.before","harness":"cursor","session_id":"…","tool":"write","input":{"path":"src/a.ts"},"cwd":"/repo"}
{"type":"tool.after","harness":"pi","session_id":"…","tool":"edit","input":{"path":"src/a.ts"},"result":{"exit":0},"cwd":"/repo"}
{"type":"turn.stop","harness":"t3","session_id":"…","last_message":"…","cwd":"/repo"}
```

### Decisions

```json
{"context":"…"}                                  // prompt.submit
{"allow":false,"reason":"outside scope"}         // tool.before
{"context":"lint failed: …","continue":true}     // tool.after
{"allow":false,"reason":"checks failed: …"}      // turn.stop
{"evidence":".ratchet/runs/<id>/checks.json"}    // turn.stop
```

The adapter translates the native response shape. Examples:

- Codex/Claude `PreToolUse`: `permissionDecision: "deny"` plus reason.
- Cursor `preToolUse`: `permission: "deny"` plus `user_message`.
- OpenCode: throw from `execute.before`; the error returns to the model.
- pi: return `{ block: true, reason }` from `tool_call`.
- Codex `Stop`: `decision: "block"` with a reason; Codex creates a continuation prompt.
- Claude `Stop`: exit 2 with the failure on stderr; Claude continues.
- Cursor `stop`: `followup_message`; Cursor submits it as the next user message.
- pi `agent_end`: `sendMessage({ triggerTurn: true })` with the failure.
- T3: `t3_thread_wait` until terminal, run checks, `t3_thread_send` the failure.

This is exactly the adapter pattern Ratchet already uses for `PreToolUse`. The difference is that the event set now covers the whole loop, not just tool calls.

## The integration ladder

Not every harness needs the same depth. Use the strongest available tier, and always keep CI as the authority.

| Tier | What it gives | Harnesses | Limits |
|---|---|---|---|
| **1. Native lifecycle hooks** | Guidance + pre-tool guard + post-tool feedback + stop gate + evidence | Codex, Claude Code, Cursor, pi, OpenCode (partial) | Per-harness adapter; hook trust differs; MCP/subagent coverage varies |
| **2. ACP proxy** | One protocol-level wrapper: prompt injection, permission/fs/terminal gates, tool-call events, turn-end checks, follow-up prompts | Any ACP agent; Claude, Codex, Cursor, OpenCode, pi via ACP adapters | Proxy RFD is draft; permission/tool reporting is optional; not a sandbox |
| **3. Control-plane supervisor** | Create a thread, inject the brief, wait for completion, run checks, send failures back | T3 MCP; any harness with a control API | No pre-tool veto unless the underlying provider has hooks; post-hoc interrupt only |
| **4. Wrapper** | Launch the harness, prepend the brief, run checks at the end | Any CLI harness | No in-loop guard or stop gate; the user can interrupt |
| **5. Gateway / proxy** | Inject system context, see requests/responses, run checks between turns | Any harness with a custom base URL | Must speak provider APIs, streaming, tools, images; holds credentials; complex |
| **6. Model-driven tools** | The model calls `ratchet.*` MCP tools | Any MCP-capable harness | The model can skip them; advisory only, never the gate |

The order is deliberate. Tiers 1–3 give deterministic enforcement without a model in the loop. Tier 6 is the weakest and should never be the only mechanism.

## ACP: the universal extension mechanism (draft)

Strictly, there is **no finalized universal hook standard**. Agent Plugins 1.0.0 makes skills and MCP portable, but explicitly leaves hooks to client extension namespaces. Cursor loading Claude Code hooks is a two-harness compatibility bridge, not a standard.

There is, however, a draft universal **extension** mechanism that is explicitly designed to subsume hooks:

> “Enable a universal agent extension mechanism via ACP proxies, components that sit between a client and an agent. Proxies can intercept and transform messages… they serve as a universal extension mechanism that can subsume AGENTS.md, hooks, MCP servers, etc.”
>
> — ACP RFD, *Agent Extensions via ACP Proxies* (Draft)

### What ACP is

The **Agent Client Protocol** standardizes communication between editors/IDEs and coding agents. It is JSON-RPC over stdio/HTTP/WebSocket, and it is already broad:

- **Agents**: Claude (via Zed's SDK adapter), Codex CLI (via ACP's adapter), Cursor, OpenCode, pi (via `pi-acp`), Gemini CLI, GitHub Copilot, Goose, Cline, and many more.
- **Clients**: Zed, Neovim, VS Code, JetBrains, Emacs, T3 Code (ACP providers), and a long list of desktop/web clients.

ACP v1 is stable. ACP v2 is in preview/draft; T3 negotiates both. The **proxy chain** RFD is draft, with a canonical Rust conductor (`sacp-conductor`).

### How a Ratchet ACP proxy would work

```text
Editor / IDE
    │  ACP
    ▼
Ratchet ACP proxy
    │  ACP
    ▼
Real agent (Claude, Codex, Cursor, OpenCode, pi, …)
```

The editor points its agent command at `ratchet acp -- <real-agent-command>`. Ratchet speaks ACP on both sides. This is a two-ended wrapper; the RFD's conductor/proxy chain is the standardized form of the same idea. The wrapper is implementable today without editor support for first-class proxy installation.

It can:

| ACP surface | Ratchet use | Guarantee |
|---|---|---|
| `session/prompt` | Prepend the contract brief and skill shortlist | Proxy controls the prompt; strong |
| `session/request_permission` | Allow/deny a tool call against contract scope | Agent **MAY** ask; not guaranteed |
| `fs/write_text_file` | Enforce writable paths | Only if the agent uses client filesystem capabilities |
| `terminal/create` | Enforce command/deny policy | Only if the agent uses client terminal capabilities |
| `session/update` `tool_call` / `plan` | Record activity, detect out-of-scope writes, update the feed | Agent **SHOULD** report; not guaranteed |
| Prompt response / turn end | Run the full check suite; send a follow-up prompt with failures | v1 prompt response; v2 `state_update`; proxy controls the boundary |
| `session/cancel` | Interrupt on a violation | Proxy can send |

This is the closest thing to “build Ratchet once, connect to many harnesses.” One proxy can wrap any ACP agent; the agent-specific differences stay inside the ACP adapter.

### What ACP cannot guarantee

- **Permission requests are optional.** ACP says the agent **MAY** request permission before executing a tool. If it does not, the proxy may only see the tool call after the fact.
- **Tool-call reporting is optional.** The agent **SHOULD** report `tool_call` updates, not MUST. The proxy’s activity feed is only as complete as the agent’s reporting.
- **Filesystem/terminal gating is capability-based.** If the agent executes its own terminal or writes files directly, the client methods are bypassed.
- **System prompt injection is still an unstable RFD.** ACP currently has no stable system-level instruction field; Ratchet prepends context to `session/prompt`. The *Client-Provided System Prompt* RFD is implemented behind an unstable feature and would make this system-level.
- **The proxy chain RFD is draft.** Editors do not yet universally expose “install a proxy”; the simple wrapper (`ratchet acp -- <agent>`) works today for any ACP client that lets you set the agent command.
- **ACP is a trusted-editor model, not a sandbox.** The agent still runs tools; the proxy is a control point, not physical isolation.

So ACP is the best **single universal adapter**, but it is not a replacement for native hooks when you need guaranteed pre-tool blocking. The right architecture is ACP for breadth, native hooks for depth, and CI for authority.

### Universal candidates compared

| Candidate | Coverage | Status | Enforcement strength |
|---|---|---|---|
| **ACP proxy** | Claude, Codex, Cursor, OpenCode, pi via ACP adapters; many editors | ACP v1 stable; proxy RFD **draft** | Prompt injection, permission/fs/terminal gates, turn-end checks; pre-tool is not guaranteed |
| **Claude Code hooks** | Claude Code + Cursor (Cursor loads Claude hooks) | Stable | Strong pre-tool/stop; only two harnesses |
| **Agent Plugins 1.0.0** | Skills + MCP across clients | Stable | Hooks are client-specific namespaces; no portable hook semantics |
| **MCP** | Tools/resources across clients | Stable | Tool calls only; no prompt/turn lifecycle; model-invoked |
| **Native adapters** | Each harness separately | Varies | Strongest per harness; most implementation work |

This is the honest ranking. ACP is the broadest single bet, but it is a draft proxy RFD on top of a stable protocol. Native hooks are the deepest but narrowest. The core should support both.


## Does a model need to drive Ratchet?

There are two different questions.

### “Should the model call Ratchet to enforce the contract?”

No. If the model calls `ratchet check`, it can forget, skip, or lie about it. That is the same trust problem Ratchet exists to remove. The **harness or a controller** must invoke Ratchet at the lifecycle point. CI must re-run the same checks.

### “Can a model act as the outer supervisor for a harness with no hooks?”

Yes, as a fallback. A supervisor agent can:

1. call `ratchet route` to create the contract;
2. launch a harness thread with the brief;
3. watch the thread/activity;
4. call `ratchet guard` on observed tool events where possible;
5. wait for the turn to settle;
6. run `ratchet stop` / `ratchet check`;
7. send failures back to the harness;
8. repeat until pass or the attempt cap.

This is **model-driven orchestration with deterministic enforcement**. The model is the transport and decision-maker for *what to do next*; Ratchet is the authority for *whether the work passes*. The model cannot override a failed check.

This pattern is useful for:

- T3, whose MCP control surface can launch/send/read/wait/interrupt threads;
- chat-only IDEs with no lifecycle hooks;
- cloud agents where local hooks do not run.

It is not the default for Codex/Claude/Cursor/pi, where native hooks are cheaper and more reliable.

A useful distinction: **MCP has two roles**. A model-facing MCP server exposes `ratchet.route`, `ratchet.check`, or `ratchet.status`; that is advisory, because the model can skip it. A control-plane MCP server, like T3's orchestration endpoint, is driven by an external supervisor; that can be part of the enforcement loop. Do not confuse the two.

The supervisor loop is small enough to be a state machine:

```text
route → launch → wait → check
                         ├── pass → done + evidence
                         └── fail → send failure → wait → check
```

The supervisor may be a model or a script. Ratchet should validate the transitions and own the final `done`; the supervisor cannot mark a failed check as passed.

### The division of responsibility

| Actor | Owns |
|---|---|
| Model | Reasoning, code, plan, skill choice |
| Harness | Prompt assembly, model call, tool execution, turn lifecycle |
| Ratchet | Contract, route, guard, checks, evidence, certification |
| Adapter | Native event ↔ normalized event |
| Renderer | Activity feed / plan panel / JSON / GitHub output |
| CI | The authority the agent cannot talk around |

A model may choose among skills and may ask Ratchet for status or scope changes. It may not certify its own work.

## T3 specifically

T3 is not a single harness. It is a **control surface** over Codex, Claude, Cursor, OpenCode, pi, Grok, Antigravity, and ACP agents. It has a public orchestration MCP server that can:

- launch a top-level thread with a prompt and workspace strategy;
- send/steer/queue a follow-up;
- read messages or the full activity timeline;
- wait for a run to reach a terminal state;
- interrupt a run;
- delegate a child task to another provider/model.

That is enough for a **T3 control-plane adapter** without T3 internals:

```text
Ratchet controller
  → t3_thread_launch(contract brief + prompt)
  → t3_thread_wait / t3_thread_read(activity)
  → ratchet check
  → pass: done
  → fail: t3_thread_send(failure + fix instruction), repeat
```

What this does not give you is a pre-tool veto. T3's MCP surface can read activity and interrupt after the fact, but it does not expose a “deny this tool call before it runs” hook. For pre-tool enforcement, use the underlying provider's hooks:

- install Ratchet in Claude/Codex/Cursor/OpenCode;
- run T3 threads on those providers;
- use T3 runtime modes and approvals as the outer boundary;
- keep CI as the final authority.

A native T3 provider adapter could expose pre-tool events, but that is a T3 change, not a Ratchet change. The MCP controller is the public, portable integration.

T3 also supports **ACP providers**, including local ACP commands. That gives a second, simpler integration: register `ratchet acp -- <agent>` as a Local ACP command in T3, and the ACP proxy wraps that agent with the contract. Use ACP where the provider is ACP; use the MCP controller where T3 is running a native provider (Codex, Claude, Cursor, OpenCode).

T3 also gives Ratchet a **cross-provider delegation** surface: a Ratchet controller can run a child on a different provider or model via `delegate_task`. That is optional; the core `delegate` concept should not depend on T3.

## What is actually portable

| Layer | Portable? | Why |
|---|---|---|
| Contract, route, policy, checks, evidence | Yes | Pure CLI/data; no harness imports |
| Prompt brief / skill shortlist | Yes | Text + files; delivered by any prompt hook or wrapper |
| Role definitions | Mostly | Concepts portable; native subagent/tool mapping differs |
| Plan schema / event schema | Yes | Data model; renderers are separate |
| Activity feed | Renderer | Same events, different UI |
| ACP proxy | Adapter | Protocol-level wrapper; broad but draft |
| Hooks | No | Agent Plugins 1.0.0 leaves hooks to client namespaces; each harness has its own API |
| Tool execution | No | Owned by the harness |
| Model call | No | Owned by the harness/provider |

The Agent Plugins 1.0.0 spec is explicit: client-specific behavior, including `com.example.client/hooks/`, is a **client extension namespace** with no portable discovery, validation, or loading semantics. There is no standardized hook spec. ACP proxy chains are the closest universal extension mechanism, but the RFD is draft; direct harnesses still need native adapters.

## What remains hard

- **Hookless IDEs**: ACP if available; otherwise tier 4/5 or a model supervisor. Never as strong as native hooks.
- **MCP and subagent calls**: some harnesses bypass the main tool hook; CI and server-side gates are the backstop.
- **Cloud agents**: Cursor runs repository hooks in cloud agents; Codex/Claude cloud support must be verified per product.
- **OpenCode v2**: the plugin API is still moving; tool gating is proven, prompt/system injection needs verification against the running version.
- **Trust and consent**: adapters execute local commands and read prompts. They need the same trust review as any hook.
- **Latency**: every hook is a process spawn unless the adapter uses a daemon. Keep the CLI fast; consider a local long-lived policy server later.

## Research notes

Fetched 2026-10-20. The web search backend returned no results, so these were read directly.

- [Codex hooks](https://developers.openai.com/codex/hooks): `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`; `additionalContext`; `decision: "block"` on `Stop` creates a continuation prompt.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`; exit 2 blocks/continues; stdout becomes context on prompt events.
- [Cursor hooks](https://cursor.com/docs/agent/hooks): `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `afterFileEdit`, `stop` with `followup_message` and `loop_limit`; `failClosed`; cloud agents run repository hooks; Cursor can load hooks from third-party tools like Claude Code.
- [Agent Plugins 1.0.0](https://agent-plugins.org/specification): skills and MCP are portable; hooks live under client extension namespaces and have no portable semantics.
- [Agent Client Protocol](https://agentclientprotocol.com/): stable editor–agent protocol; agents/clients list.
- [ACP proxies RFD](https://agentclientprotocol.com/rfds/proxy-chains): draft universal extension mechanism; explicitly proposed to subsume hooks and `AGENTS.md`.
- [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls), [filesystem](https://agentclientprotocol.com/protocol/file-system), [terminals](https://agentclientprotocol.com/protocol/terminals): permission/fs/terminal surfaces a proxy can gate.
- [ACP client-provided system prompt RFD](https://agentclientprotocol.com/rfds/client-system-prompt): system-level instruction injection, currently unstable.
- [T3 orchestration MCP](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md): thread launch/send/read/wait/interrupt and cross-provider `delegate_task`.
- [T3 provider constraints](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md): provider behavior belongs behind an adapter; orchestration works with normalized commands/events.
- [OpenCode plugins](https://opencode.ai/docs/plugins/): plugin hooks, `tool.execute.before/after`, compaction hooks; v2 API is typed and still moving.

## Decision

- Ratchet's portable core is a **CLI + normalized event protocol**, not a pi extension.
- Build the **ACP proxy** as the broadest universal adapter: `ratchet acp -- <agent>`. Spike it with one agent (Claude or Codex via ACP) before generalizing.
- Keep **native hooks** for direct harnesses where depth matters: Codex, Claude, Cursor, pi; OpenCode where the v2 API permits.
- Use the **T3 control-plane supervisor** for T3 native providers; ACP covers T3's ACP agents.
- Tier 4 wrapper and tier 5 gateway for the rest; tier 6 model tools are advisory only.
- No model in the pass/fail path. A model may drive the outer supervisor, never the certification.
- CI remains the authority in every tier.
