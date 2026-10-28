# Vision: trust by construction

**Status:** draft, 2026-10-20
**Companions:** [design.md](design.md) for the enforcement kernel; [routing.md](routing.md) for the routing research and evaluation plan; [pi-gap.md](pi-gap.md) for the pi orchestrator → Ratchet gap analysis; [universal-integration.md](universal-integration.md) for the lifecycle protocol and adapter ladder.

## The sentence

Every task an agent starts should leave behind a contract, a boundary, and a machine check that can fail — without the user typing a setup command.

The user types the prompt. Ratchet turns it into a small, enforceable task. The model still does the work. The difference is that "done" now means a command exited zero, not that the model said it was done.

## What Ratchet is

Ratchet is a harness-neutral **orchestration and verification framework**. It generalizes the pi orchestrator's system prompt, specialist roles, plan/activity feedback, scope/budgets, and deterministic checks to every harness. It adds the trust ladder: codebase invariants, full static analysis, prose-to-check audit, and human review.

The pi extension is the first implementation and the reference adapter. The contract/evidence kernel is the part that makes the loop trustworthy; it is not the whole product. The gap between the two is documented in [pi-gap.md](pi-gap.md).

## The problem

Agents are fast. The bottleneck is trust.

A line in `AGENTS.md` or a skill is prose. It competes with everything else in the context window and can be skipped at turn 40. A human review catches some of it, but not at the rate agents land code. The question is not "did the model say it ran the tests?" The question is:

> What fails if the model is wrong?

If the answer is "a reviewer might notice", the rule is not enforced. It is a hope.

The tweet's four layers are an enforcement ladder, not four kinds of documentation:

| Layer | Mechanism | What fails | Token cost |
|---|---|---|---|
| 1. Codebase | One owner per state, typed boundaries, one supported API | The compiler or import graph rejects the wrong shape | Lowest |
| 2. Static analysis | Types, lint, tests, CI, formal models | A command exits non-zero | Low |
| 3. Prose | Comments, `AGENTS.md`, skills, briefs | A human notices the model skipped it | Medium, unreliable |
| 4. Human review | Intent, product tradeoffs, irreversible actions | A reviewer catches it | Highest |

The inverse pyramid is a budget instruction: spend most effort at layer 1, then 2, then 3, and reserve layer 4 for what only a human can decide. A skill library sits at layer 3. It can improve the model's choices. It cannot be the foundation of trust, because nothing fails when it is ignored.

Ratchet's job is to move rules down this ladder. A repeated correction becomes a check. A check becomes a gate. A gate becomes a boundary. Prose is what remains after the machine-enforceable parts have been extracted.

## The promise

For every task, in every supported harness:

1. **A contract exists before the model writes.** Role, scope, deny list, budgets, verification commands, and the checks that decide "done".
2. **The right skills are in front of the model.** Ratchet selects a contract profile and a shortlist of skills from the prompt and the repository, then injects a brief. The model reads the skills; it is not asked to remember them from a previous session.
3. **Every tool call is checked.** Writes outside scope, denied paths, exhausted budgets, and missing gates are refused with a reason the model can act on.
4. **The turn cannot end on a lie.** When the model tries to finish, Ratchet runs the checks. If they fail, the model gets the failure and another turn. If they pass, the evidence is recorded.
5. **CI re-runs the same checks.** The in-loop hook is fast feedback. Git hooks and required CI are the authority the model cannot talk around.

The normal flow has no `ratchet task start`. Manual commands remain for explicit scopes, debugging, and power users.

## The loop

```text
 user prompt
      │
      ▼
 [UserPromptSubmit]  ratchet route
      │  • match a contract profile (closed set, confidence required)
      │  • select a skill shortlist (open set, model may choose)
      │  • create or reuse the contract
      │  • inject the brief + skill paths
      ▼
   model turn
      │
      ├── tool call ──► [PreToolUse] ratchet guard ──► allow / deny
      │                                      │
      │                                      └── reason + contract path
      │
      └── tries to finish
              │
              ▼
        [Stop] ratchet stop
              │  • run the contract's verify commands
              │  • pass  → record evidence, allow the final answer
              │  • fail  → block the stop, return the failures
              │            model fixes; repeat up to N times
              ▼
          final answer
              │
              ▼
        CI: ratchet check (required)
```

If a harness has no blocking stop hook, the same check runs in `ratchet run`, the git pre-commit hook, and CI. The turn is then not certified in-loop; the repository still is.

## What "automatic" means

**One contract per thread, not per prompt.** A new thread gets a new contract on its first prompt. Follow-up prompts in the same thread reuse it. A new task in the same thread is an explicit replacement (`ratchet task start --profile ...`), not a silent scope change. This is deterministic and avoids guessing whether "also fix the header" is a new task.

**The repository owns the policy.** `.ratchet/config.json` defines the profiles, default scope, deny list, budgets, verify commands, and gates. The router chooses among profiles; it does not invent scope. If no profile is a confident match, the `general` profile applies.

**The prompt is read locally, not stored.** The router needs the prompt to match skills. By default it stores a hash, the selected profile, the skill shortlist, scores, and the router version — not the raw text. Raw prompt storage is opt-in. If a remote embedding or tie-break model is ever enabled, it is opt-in and documented.

**No check, no certified done.** If the repository has no checks, `ratchet init` bootstraps from `package.json` or the project's test/lint/build commands. If there is still nothing to run, the contract can be created but `done` is marked `uncertified`; a human waiver is required. A green check is the only automatic certification; a waiver is explicit and recorded, not a pass.

**The check surface is part of the contract.** The commands, scripts, and config that define the checks are hashed. If the model weakens a test script or edits a check to make it pass, the stop gate refuses: "check surface changed; amend the contract on the record or revert." `ratchet amend --reason "..."` re-baselines the lock with the old hash, the new hash, and the reason stored in the contract, so adding real tests inside a task is a recorded step rather than a bypass. Canary checks prove the check can actually fail.

## The architecture

### One contract

`.ratchet/runs/<id>/contract.json` is the single source of truth. `.ratchet/current` points to the active run.

The contract is deliberately small:

| Field | Meaning |
|---|---|
| `id`, `session`, `created_at` | Identity and thread binding |
| `goal` | Prompt hash plus an optional short goal string |
| `profile` | The selected contract profile (`general`, `feature`, `bugfix`, `docs`, …) |
| `role` | `coder`, `reviewer`, `writer`, or a repo-defined role |
| `scope` | Writable globs; everything else is denied |
| `deny` | Secrets, `.git`, vendor, generated files, destructive paths |
| `budgets` | Writes, distinct files, bash calls, turns |
| `verify` | The commands that must pass |
| `gates` | Required artifacts before source writes (plan, test, sketch, proof) |
| `checks_lock` | Hashes of the check surface |
| `route` | Profile, skills, scores, router version, decision |
| `stop` | Attempt count, max attempts, last failure summary |

Everything is plain JSON. Any harness, script, or CI job can read it. Nothing important lives only in a model's context.

Contracts are keyed by harness session. Adapters pass the session id on every event, and the guard resolves the contract by session rather than by the global `.ratchet/current` pointer. That pointer stays for humans and single-thread CLI use, so two concurrent threads do not share scope.

### Two outputs, two confidence levels

This is the key routing decision.

| Output | Set | Confidence | Who acts |
|---|---|---|---|
| **Contract profile** | Closed, repo-defined | High; otherwise `general` | Ratchet. It sets scope, verify, and gates. |
| **Skill shortlist** | Open, grows with installed skills | Ranked, not certain | The model. It reads the relevant skills and may choose another. |

A profile is enforceable and testable. A skill is prose. Mixing them into one classifier is what makes routing brittle: a wrong label then becomes a wrong gate. Separating them means a routing mistake costs tokens, not trust. The general profile still enforces tests and lint; a missed specialized skill is recoverable, and the model can ask for it.

The model may request a profile change or an additional skill. Ratchet records the request, updates the contract only through an explicit command, and re-runs the checks. No silent widening.

### Three hook points

| Point | Command | Input | Output | Failure behavior |
|---|---|---|---|---|
| Prompt | `ratchet route` | prompt, session, cwd | contract + brief + skill shortlist | Fail to `general`; block only on a hard policy violation such as a secret |
| Tool | `ratchet guard` | normalized tool event | `allow` / `deny` + reason | Fail closed on missing or malformed contract |
| Stop | `ratchet stop` | session, contract, last message | `allow` or `block` + failure text | Fail closed; cap continuations, then mark uncertified |

The adapters are thin. They normalize one harness event, call one CLI command, and translate the result back. All policy lives in the CLI, so every harness gets the same rules.

### Two enforcers

```text
                    contract.json
                   /             \
          in-loop adapter      out-of-loop gate
       (prompt/tool/stop)     (git hook / CI / branch protection)
            fast feedback          authoritative
            teaches in a turn      cannot be talked around
```

A hook is policy, not a sandbox. It can be bypassed by an unhooked tool, a subagent, an MCP call, or `--no-verify`. The physical layers are a container or read-only checkout, branch protection, CODEOWNERS, and required checks. Ratchet makes the cheap path correct and the expensive path authoritative. It does not pretend a hook is physics.

### Components

| Component | Job | Fails closed? |
|---|---|---|
| Router | Prompt → profile + skill shortlist + contract brief | Yes, to `general` |
| Contract store | One JSON per run; `.ratchet/current` | Missing/malformed → guard denies |
| Guard | Path, scope, deny, budget, and gate decisions | Yes |
| Stop gate | Runs checks before the turn ends; returns failures | Yes, with a loop cap |
| Check runner | Executes the repo's commands; captures exit codes and logs | Yes |
| Evidence / `done` | Certifies only with passing evidence; writes `result.json` | Yes |
| Skill registry | Parses installed skills; descriptions, examples, routing metadata | Empty registry → general profile |
| Adapters | Map harness lifecycle events to the CLI | No-op outside a contract |

### The portable orchestration core

The core owns the decision; adapters own the event plumbing; renderers own the display. This is the same split the pi extension already uses internally, generalized.

| Concept | Portable artifact | Pi source today |
|---|---|---|
| Task | `contract.json` | `scope` + `task start` |
| Route | `route.json` | missing; the orchestrator prompt is static |
| Role / profile | `profiles.json`, role definitions | `specialists.ts` |
| Plan | `plan.json`, plan events | `plan-tool.ts`, `plan-panel.ts` |
| Delegation | child contract | `delegate-pipeline.ts` |
| Feedback | `events.jsonl` | `activity-feed.ts` |
| Checks | `checks.json`, `result.json` | `lint-guard.ts` + verify |
| Rules | `rules.tsv` | missing |
| Review | `review.json` | missing; `ask_orchestrator` is model-to-model |
| Adapter | lifecycle map | `index.ts` |
| Renderer | event → view | `plan-panel.ts`, `activity-feed.ts` |

The core must run without pi. That is the portability test: the same contract, guard, stop gate, and check runner behind every adapter.

## The trust boundary

The router is not the trust boundary. The contract, the guard, the stop gate, and CI are.

This matters because routing will be wrong sometimes. A prompt is ambiguous; a skill description overlaps another; a user types "fix the thing" with no context. If routing were the trust boundary, every ambiguity would be a security decision. It is not. A wrong route can:

- waste tokens on an irrelevant skill,
- choose a profile whose checks are too weak for the task,
- miss a specialized gate such as a proof or a migration check.

The first is cheap. The second is mitigated by the general profile always requiring tests and lint. The third is the real risk, which is why profile selection requires confidence and why a profile change is explicit and recorded. The stop gate and CI still decide whether the work is good.

Do not use a regex maze as the sole router. Do not use an unconstrained LLM as the sole router. Use explicit signals, retrieval, a constrained tie-break when needed, and abstention. The full argument and the evidence are in [routing.md](routing.md).

## The pi orchestrator is the reference implementation

The pi orchestrator is the first implementation of the portable core. It already contains the system prompt composition, specialist roles, plan/activity feedback, scope guard, budgets, and lint loop. Ratchet generalizes those mechanisms across harnesses and adds the missing trust layers; it does not rebuild the pi UX. The detailed gap analysis is in [pi-gap.md](pi-gap.md).

| pi mechanism | Where it lives | What it proves | What Ratchet generalizes |
|---|---|---|---|
| System prompt composition | `prompt-builder.ts`, `before_agent_start` | A harness can replace the model's role, roster, routing table, scope shape, and communication contract before the turn | `ratchet route` renders the contract brief and skill shortlist; the same policy is rendered per harness |
| Specialist prompts | `specialists.ts` | Role-specific capabilities, planSteps-first, scope guidance, findings/audit/difficulty | Contract profiles + role/specialist selection; the router chooses the profile, the orchestrator chooses the specialist |
| Plan + activity feed | `plan-tool.ts`, `activity-feed.ts`, `plan-panel.ts` | Structured steps, substeps, errors, reports, and a live feedback surface | Route, guard, check, and stop events become feed items; `checks.json` remains the evidence |
| Scope guard | `scope-guard.ts`, `scope-manager.ts` | Per-delegation, fail-closed write boundaries; reads allowed; temp-scratch exceptions; line caps | `contract.scope` + `ratchet guard`, resolved per session; per-child scope for subagents |
| Counted budgets | `specialists.ts`, budget gate | Exploration/files/turns counted by the framework, not self-reported | `contract.budgets` + deny/escalate; the same numbers in the brief and the gate |
| Auto-lint | `lint-guard.ts` | After edit/write, run the detected linter; on failure send a `customType: "lint"` message with `triggerTurn: true`, forcing a fix turn | `PostToolUse` fast lint + `Stop` full verification; lint is fast feedback, not the final gate |
| Structured output | `FINDINGS_AUDIT_TEMPLATE`, Difficulty | Findings, audit, scope notes, and difficulty are structured for the orchestrator | Ratchet records evidence and checks; it never accepts the self-report as proof |
| `delegate()` | `delegate-tool.ts`, `delegate-pipeline.ts`, `subagent-runner.ts` | Child sessions with role, scope, skills, budgets, and a result contract | The guard applies to child tool calls; each child gets a contract view; the parent gets evidence, not just prose |

The important distinction is between the **feedback surface** and the **evidence**. The activity feed and the lint message are feedback: they tell the model what to fix, and they are excellent at that. They are not evidence that the task is correct. A lint pass on one edited file does not prove the tests pass, the architecture holds, or the tamper check is intact. That is the gap the stop gate fills.

The other gap is the start of the loop. The orchestrator composes a system prompt when the turn begins, but the user still creates the task manually. Ratchet's prompt route (Codex/Claude `UserPromptSubmit`, pi `before_agent_start`) creates the contract and injects the brief before the model sees the prompt. The pi adapter uses the existing `before_agent_start` machinery to deliver it.

So the layering is:

```text
Ratchet policy        contract, profile, scope, verify, evidence
      ↓
pi orchestrator       system prompt, specialists, plan, activity feed
      ↓
subagents             coder / scout / reviewer / researcher / writer
      ↓
checks                lint, typecheck, tests, arch, tamper, CI
```

Ratchet does not replace `prompt-builder.ts`, `specialists.ts`, or the activity feed. It gives them a portable contract and a final gate. The pi extension remains the best place to see the loop working end to end.


## Seamless across harnesses

There is no single lifecycle-hook contract implemented identically across IDEs. Agent Skills and Agent Plugins package skills, MCP servers, and metadata; they do not give every IDE the same prompt/tool/stop hook contract. "Every IDE" is therefore an adapter matrix plus a fallback ladder, not one magic integration.

| Harness | Prompt hook | Tool guard | Stop gate | Status |
|---|---|---|---|---|
| Codex | `UserPromptSubmit` | `PreToolUse` | `Stop` | Tool guard installed; prompt + stop next |
| Claude Code | `UserPromptSubmit` | `PreToolUse` | `Stop` | Tool guard installed; prompt + stop next |
| pi | `before_agent_start` (prompt + system prompt) | `tool_call` | `agent_end` + `sendMessage({ triggerTurn: true })` (soft) | Reference implementation; add the full-contract stop gate |
| OpenCode 2 | plugin `chat.message` / system transform (verify v2) | `tool.execute.before` | session idle + client prompt (soft) | Tool guard exists; prompt/stop partial |
| T3 Code | T3 native thread/prompt lifecycle; ACP `session/prompt` | T3 permission modes; ACP `request_permission`; provider hooks | T3 run completion + `ratchet check`; ACP follow-up | Harness + control plane; native adapter if exposed; MCP/ACP fallbacks |
| Cursor | `beforeSubmitPrompt` | `preToolUse` | `stop` + `followup_message` | Hooks available; Claude-compatible; adapter to build |
| ACP agents | `session/prompt` (proxy prepends) | `session/request_permission`; fs/terminal (capability-gated) | prompt response + follow-up `session/prompt` | ACP v1 stable; proxy RFD draft |
| Generic CLI | `ratchet run` wrapper | `ratchet guard` via wrapper | `ratchet check` after the run | Works anywhere; less seamless |

The fallback ladder:

1. **Native hooks** — the full loop, best UX.
2. **ACP proxy** — one protocol-level wrapper for any ACP agent; broad, but the proxy RFD is draft.
3. **Control-plane supervisor** — T3 MCP or another control API; launch, wait, check, send failures.
4. **Wrapper** — `ratchet run <harness> "prompt"` creates the contract, launches the harness, and runs checks at the end. Works for harnesses without hooks.
5. **Repository gate** — git pre-commit and required CI. Always present; the authority of last resort.
6. **Gateway** — an OpenAI/Anthropic-compatible proxy for hookless IDEs. It can inject skills and inspect requests at the HTTP boundary, but it is a large, security-sensitive build. Phase 3, not Phase 1.

The user experience is the target across the matrix: type the prompt, get a contract, get blocked when out of bounds, get stopped when checks fail. The integration underneath is per-harness, and the docs should say so.

There is no finalized portable hook standard. Agent Plugins 1.0.0 leaves hooks to client extension namespaces. The closest universal extension mechanism is **ACP proxy chains**: ACP is a stable editor–agent protocol, and its draft proxy RFD is explicitly designed to subsume hooks and `AGENTS.md`. The practical shape is `ratchet acp -- <agent>`: one proxy between the editor and any ACP agent, with prompt injection, permission/fs/terminal gates, tool-call events, and turn-end checks. Build ACP for breadth, native hooks for depth, and the T3 MCP controller for T3's native providers. The normalized event protocol and the full ladder are in [universal-integration.md](universal-integration.md).

### Who drives what

| Actor | Owns |
|---|---|
| Model | Reasoning, code, plan, skill choice |
| Harness | Prompt assembly, model call, tool execution, turn lifecycle |
| Ratchet | Contract, route, guard, checks, evidence, certification |
| Adapter | Native event ↔ normalized event |
| Renderer | Activity feed, plan panel, JSON, GitHub output |
| CI | The authority the agent cannot talk around |

A model may drive an **outer supervisor** for a harness with no lifecycle API: launch it, watch it, run Ratchet checks, send failures back. The model is the transport there, not the judge. The checks stay deterministic, and the model cannot override a failed check.

## Profiles, not a rule maze

A profile is a named, tested contract template. The repo defines a small set:

| Profile | Use | Gates | Verify |
|---|---|---|---|
| `general` | Anything not confidently classified | Plan for multi-file work | Tests + lint |
| `feature` | New behavior | Plan, test-first | Tests + lint + build |
| `bugfix` | Regression fix | Failing regression test first | Tests + lint |
| `refactor` | Behavior-preserving change | Plan, architecture check | Tests + lint + arch |
| `docs` | Documentation only | None | Link check / docs build |
| `proof` | Formal or invariant-heavy work | Laws before implementation | Proof oracle (e.g., Bend) |

Profiles are few, versioned, and tested. The router's job is to pick one with high confidence or fall back to `general`. Skills are many and retrieved separately. This is the difference between a decision that can be enforced and a label that is merely plausible.

A profile can extend another (`feature` extends `general`), so the common checks are defined once. A profile change is an explicit contract operation, recorded in `events.jsonl`.

## What this is not

- **Not a model gateway (yet).** Ratchet does not hold API keys, proxy inference, or stream tokens. The hook-based router shapes context; the harness still talks to the provider. A gateway is a later option for hookless IDEs.
- **Not a sandbox.** A hook can be bypassed. Containers, read-only checkouts, branch protection, and required checks are the hard boundary.
- **Not an LLM judge.** No model decides whether the work passes. Models may help route skills; they do not certify.
- **Not a model that plans for you.** Ratchet provides the plan structure, gates, and feedback loop; the model or orchestrator fills the plan. The contract stays small.
- **Not a replacement for pstack.** pstack is a library of engineering playbooks. Ratchet is the enforcement kernel those playbooks can call.
- **Not a guarantee against a malicious agent.** It is a guardrail plus evidence. A determined agent with unrestricted shell access can still do damage; that is why the authoritative layers are outside the agent.

## Phases

### Phase 0: extract the portable core from pi

- Freeze the schemas: contract, route, plan, event, check, result, rules, review. Version them.
- Move the pure policy out of pi: scope guard, bash classifier, budgets, structured-output parser, check runner. No pi imports; tests run without pi.
- Define the adapter and renderer interfaces. The event schema is the contract between them.
- Build the CLI: `ratchet route`, `guard`, `stop`, `check`, `done`, `audit`.
- Wire the CLI into pi as the reference integration: reuse `prompt-builder.ts`, `specialists.ts`, `activity-feed.ts`, `plan-tool.ts`, and `lint-guard.ts`; keep the TUI.

**Acceptance:** pi still works; the core tests run without pi; a contract can be guarded and checked from the CLI; the same events render in the activity feed.

### Phase 1: the automatic loop for Codex and Claude

- `ratchet route --prompt` with explicit signals, lexical retrieval, a skill shortlist, and a `general` fallback.
- `auto` policy in `.ratchet/config.json`: profiles, default scope, verify, budgets, route table.
- `UserPromptSubmit` hooks for Codex and Claude: create/reuse the contract; inject the brief and skill shortlist.
- `Stop` hooks for Codex and Claude: run `ratchet stop`; block with failures; cap continuations.
- Route evaluation set (50–100 labeled prompts) and a baseline comparison.
- End-to-end test on the Flappy prompt: route → contract → guard allow/deny → stop fail → fix → stop pass → CI.

**Acceptance:** a fresh prompt in a supported harness produces a contract without `ratchet task start`; a failing lint blocks the final answer; a passing check allows it; the event trail shows route, guard, stop, and evidence.

### Phase 2: the rest of the matrix

- pi parity: the reference adapter uses the same CLI; add parity tests for route, guard, and stop; keep the existing activity feed as a renderer.
- ACP proxy: `ratchet acp -- <agent>` with prompt injection, permission/fs/terminal gates, tool-call events, and turn-end checks; spike with Claude or Codex via ACP.
- OpenCode 2: prompt injection and stop semantics; tool gating is proven; document the soft-stop limit.
- T3 control-plane adapter: `t3_thread_launch` / `t3_thread_send` / `t3_thread_read` / `t3_thread_wait` around `ratchet check`; use provider hooks for pre-tool enforcement.
- Cursor: build on its Claude-compatible hooks (`beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `stop`); verify cloud and local behavior.
- `ratchet run` wrapper for harnesses without hooks.
- Check integrity: hash the check surface; canary checks; tamper refusal.

### Phase 3: hookless IDEs and organizations

- Optional gateway for IDEs that only allow a custom base URL.
- Org policy: signed profiles, shared route registries, required checks.
- Hosted or shared evaluation of routes across repositories.

## Success metrics

| Metric | Target | How measured |
|---|---|---|
| Prompts that produce a contract | 100% in supported harnesses | `route.json` per session |
| File-changing turns stopped by checks | 100% | `stop` events vs turns with writes |
| `done` with passing evidence | 100% | `result.json` |
| Escaped defects in gated paths | 0 in CI | CI failures after merge |
| False-block rate | < 2% of tool calls | Guard denials reversed by the user |
| Route precision@1 | Beat regex baseline | Labeled eval set |
| Route abstain rate | Measured, not hidden | `route.json` decision |
| Stop-gate first-pass rate | Rising over time | `checks.json` per run |
| Added latency | < 1 s per prompt/tool/stop (local) | Timings in `events.jsonl` |
| Token overhead | < 10% of a typical task | Harness usage vs baseline |

The important metric is not "how often did the model follow the skill?" It is "how often did bad work fail before it reached a human?" The checks answer that.

## Open questions

1. **Per-thread vs per-task contracts.** The default is per thread. Multi-task threads need an explicit split; how much friction is acceptable?
2. **Prompt privacy.** Hash-only by default. What is the minimum text needed for good routing, and how is it redacted?
3. **Skill injection size.** Shortlist + paths, or full text for the top skill? Progressive disclosure says paths; some harnesses do not load skills automatically.
4. **Stop-loop policy.** Three continuations, then uncertified? Or block until a human? The cap prevents loops; the failure must remain visible.
5. **Profile confidence.** What threshold justifies a specialized profile? A wrong `proof` or `migration` profile is worse than `general`.
6. **Check bootstrapping.** What does `ratchet init` do in a repo with no tests, no lint, and no build? A generated smoke test is better than nothing; a waiver must be explicit.
7. **T3 and Cursor hooks.** T3 is its own harness; which lifecycle hooks does it expose, and does it have a blocking stop? Cursor's current hook surface needs verification.
8. **Cloud and remote agents.** Hooks that run on the developer's machine do not cover cloud sessions. The gateway or a server-side check is the only answer there.
9. **Evaluation data.** The first route set will be small and biased toward this user's prompts. It needs to grow across repos and languages.
10. **Skill quality.** A bad description makes a good router look bad. Who owns skill descriptions and routing metadata?
11. **ACP adoption.** Which target editors can point the agent command at a proxy today, and when will proxy installation be first-class? The proxy RFD is draft; the wrapper works now.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-20 | The router is advisory; checks are authoritative | Routing errors should cost tokens, not trust |
| 2026-10-20 | One contract per thread; explicit replacement for a new task | Deterministic; no per-prompt task classification |
| 2026-10-20 | Two routing outputs: profile (closed, enforceable) and skills (open, shortlist) | Separates the decision that sets gates from the prose that guides judgment |
| 2026-10-20 | No raw prompt storage by default | The router needs the prompt; the audit trail does not |
| 2026-10-20 | Hooks first, gateway later | Prove the loop on harnesses with lifecycle hooks before taking on proxy complexity |
| 2026-10-20 | No regex-only routing; cascade with abstention and evaluation | Natural language has an open-ended long tail; see [routing.md](routing.md) |
| 2026-10-20 | Check surface is hashed and canaried | A model that can weaken the check can defeat the gate |
| 2026-10-20 | ACP proxy is the broadest universal adapter; native hooks for depth | No finalized hook standard; ACP's draft proxy RFD explicitly aims to subsume hooks |
| 2026-10-20 | ACP is a breadth adapter, not the first build | Proxy RFD draft; current harnesses have direct hooks/control planes |
