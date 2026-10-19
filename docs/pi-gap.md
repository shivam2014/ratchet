# Pi orchestrator → Ratchet: gap analysis

**Status:** working note, 2026-10-20
**Purpose:** define what to extract from the pi orchestrator, what to generalize, and what is still missing relative to the four-layer trust model.

## The relationship

The pi orchestrator is the **first implementation** of Ratchet's portable core, not a separate product to replace.

Ratchet is the harness-neutral framework that gives every agent:

- the orchestrator's system prompt and specialist roles,
- the plan and activity-feedback loop,
- delegation with scope and budgets,
- deterministic checks and a stop gate,
- the trust ladder: codebase invariants, full static analysis, prose-to-check audit, and human review.

Pi is where the loop is proven. Codex, Claude Code, T3/OpenCode, and Cursor are the port targets. The portable core must have no pi imports.

## What pi already implements

| Capability | Where | What is portable | What is pi-specific |
|---|---|---|---|
| System prompt composition | `index.ts` (`before_agent_start`), `prompt-builder.ts` | Role, roster, routing table, scope shape, communication contract | pi SDK prompt sections, `getReadmePath()`, model-specific intro replacement |
| Specialist roster | `specialists.ts` | Role definitions, tool capabilities, read-only vs writable, suggested skills | Prompt wording, pi tool names |
| Plan | `plan-tool.ts`, `plan-panel.ts` | Plan schema, step kinds, `planSteps` / `advanceStep`, loop steps | TUI panel, singleton/lifecycle details |
| Activity feed | `activity-feed.ts` | Step/substep event model, tool detail, error state, report items, token line | TUI rendering, theme, width calculations |
| Scope guard | `scope-guard.ts`, `scope-manager.ts` | Fail-closed path policy, read allowance, temp-scratch exceptions, line caps, per-delegation file | `.pi/scope.json`, pi tool event shape |
| Budgets | `specialists.ts`, budget gate | Counted exploration/files/turns, escalation thresholds, audit scale | pi session counters |
| Lint / typecheck | `lint-guard.ts` | Auto-run after edit/write, language detection, failure message with `triggerTurn` | pi `tool_result` hook, `sendMessage`, pi tool registry |
| Delegation | `delegate-tool.ts`, `delegate-pipeline.ts`, `subagent-runner.ts` | Child contract, specialist, scope, skills, budget, structured result | pi subagent session/runner |
| Structured output | `FINDINGS_AUDIT_TEMPLATE`, `DIFFICULTY_TEMPLATE` | Findings/audit/difficulty schema; scope notes; result semantics | Prompt wording |
| Clarification | `ask-resolver.ts`, `ask_orchestrator` | One-question protocol, recommendation-first, escalation signal | pi message plumbing |
| Fusion | `fusion-*.ts` | Optional multi-model planning | pi model/provider plumbing |

## What pi lacks relative to the four layers

### Layer 1 — codebase improvements

Pi enforces **where** a write can happen. It does not enforce **what shape** the codebase must have.

Missing:

- import boundaries and dependency rules (`import/no-restricted-paths`, dependency-cruiser, ArchUnit-style checks);
- type-level invariants and type tests;
- one-owner-per-state checks, forbidden duplicate APIs, dead-code checks;
- codegen drift checks (generated files match their schema);
- forbidden API or pattern checks;
- an explicit map from a design rule to its enforcer and proof.

`scope-guard.ts` is a path boundary, not an architecture boundary. A coder can stay inside `src/` and still add a second state store, a duplicate API, or a circular dependency.

**Ratchet adds:** architecture commands in `verify`, `rules.tsv` entries for design invariants, codegen/type tests, and `ratchet audit` refusing a rule that claims a machine layer without an enforcer or proof.

### Layer 2 — static analysis

Pi has deterministic **per-file** checks:

- `lint-guard.ts` runs a linter or `tsc` after `edit`/`write`;
- on failure it sends a `customType: "lint"` message with `triggerTurn: true`;
- the prompt calls lint/error/block messages "blocking feedback".

That is excellent fast feedback. It is not a full verification gate.

Missing:

- a stop gate that runs the full `verify` suite before the final answer;
- enforced tests, architecture checks, tamper checks, Bend/TLA+ proofs, and build checks (the coder may run them ad hoc; the framework does not require them);
- CI parity: the same commands locally and in required CI;
- check integrity: hashing the check surface so the model cannot weaken a test to make it pass;
- a canary that proves the check can actually fail;
- immutable evidence (`checks.json`, `result.json`) rather than feed state;
- a loop cap for repeated failures.

A model can pass lint on the edited file and still leave failing tests, a broken architecture, or a modified test script. The lint guard also only re-runs when the model edits a file; it does not force a final verification pass.

**Ratchet adds:** `ratchet stop` runs the contract's full `verify` at the turn boundary, returns failures as a continuation, caps attempts, writes evidence, and CI re-runs the same commands. `--pstack` and `--bend` are examples of gates that require artifacts before code.

### Layer 3 — prose

Pi has a rich prose layer:

- the orchestrator system prompt;
- specialist prompts;
- `AGENTS.md` and project instructions;
- `read_skill` / `list_skills` and suggested skills;
- the communication contract and clarification protocol.

What is missing is **auditability of the prose**:

- no rule table that pairs each repeated correction with an enforcer and a proof;
- no report of prose-only rules that nothing enforces;
- no `create-verification-skill` workflow that turns a recurring review comment into a check;
- no per-prompt skill routing; the roster is static and the model decides what to read;
- no guard against prompt drift: a hard rule can be added to the prompt without a corresponding gate;
- no explicit "advisory" label for skills whose requirements are not machine-checked.

**Ratchet adds:** `ratchet route` (profile + skill shortlist), `ratchet audit` (rule → layer → enforcer → proof), prompt snapshots that fail when a hard rule has no check, and a verification-skill template. Prose remains necessary for judgment; it stops being the only mechanism.

### Layer 4 — human review

Pi's `ask_orchestrator` is model-to-model clarification, not human review. It does not have:

- a contract approval step;
- risk classification (irreversible action, auth, migrations, destructive commands);
- CODEOWNERS or reviewer routing;
- required human approval for protected paths;
- a review artifact that records who approved what and why;
- a way to spend human attention on the highest-leverage decisions instead of every diff.

**Ratchet adds:** a review policy in the contract, risk profiles, approval gates for irreversible actions, CODEOWNERS-aware routing, and a `review.json` artifact. The goal is not to review every PR; it is to route the few decisions that need a human and leave the rest to checks.

## Cross-harness gaps

Pi is pi-only:

- `before_agent_start`, `tool_call`, `agent_end`, `tool_result` are pi lifecycle events;
- `sendMessage`, `setActiveTools`, `registerTool`, subagent sessions, and the TUI are pi SDK surfaces;
- the plan panel and activity feed are pi renderers;
- there is no Codex, Claude Code, OpenCode/T3, or Cursor adapter;
- there is no portable event schema, renderer interface, or check runner;
- there is no `ratchet run` fallback for harnesses without hooks.

**Ratchet adds:** a CLI, a portable contract/event/check schema, thin adapters per harness, renderers (TUI, CLI, JSON, GitHub), and CI as the authority of last resort.

## The portable core

This is the part that must have no pi imports.

| Concept | Portable artifact | Pi source today | Adapter / renderer boundary |
|---|---|---|---|
| Task | `contract.json` | `scope` on `delegate()`; no persistent task contract | Adapter passes session id and cwd |
| Route | `route.json` | missing | Prompt hook calls `ratchet route` |
| Role / profile | `profiles.json`, role definitions | `specialists.ts` | Adapter maps to harness subagents/roles |
| Plan | `plan.json`, plan events | `plan-tool.ts` | Renderer displays the plan |
| Delegation | child contract | `delegate-pipeline.ts` | Harness subagent API |
| Feedback | `events.jsonl` | `activity-feed.ts` | TUI / CLI / JSON renderer |
| Checks | `checks.json`, `result.json` | `lint-guard.ts` + verify | Hook runner and CI |
| Rules | `rules.tsv` | missing | `ratchet audit` |
| Review | `review.json` | missing | CODEOWNERS / approvals |
| Adapter | lifecycle map | `index.ts` | One per harness |
| Renderer | event → view | `plan-panel.ts`, `activity-feed.ts` | One per surface |

The core owns the **decision**; adapters own the **event plumbing**; renderers own the **display**. That is the same split the pi extension already uses internally, generalized.

## What not to port

- pi SDK imports and event types;
- TUI layout, theme, width calculations, plan-panel singleton behavior;
- model-specific prompt wording and provider/model configuration;
- fusion (optional orchestration feature, not core);
- `getReadmePath()` and other pi documentation paths.

Keep them in the adapter or renderer. Do not let them leak into the core.

## Migration sequence

1. **Freeze the schemas.** Contract, route, plan, event, check, result, rules, review. Version them.
2. **Extract the pure policy.** Scope guard, bash classifier, budgets, output parser, check runner. Add tests that run without pi.
3. **Build the CLI.** `ratchet route`, `guard`, `stop`, `check`, `done`, `audit`.
4. **Pi adapter first.** Reuse `prompt-builder.ts`, `specialists.ts`, `activity-feed.ts`, `plan-tool.ts`, `lint-guard.ts`; add `ratchet route` before the turn and `ratchet stop` at `agent_end`.
5. **Codex and Claude adapters.** `UserPromptSubmit`, `PreToolUse`, `Stop`.
6. **OpenCode/T3, Cursor, `ratchet run`.** Use the same CLI; document soft-stop limits.
7. **Add the missing layers.** Architecture checks, full verify, check integrity, rules audit, review policy.
8. **Evaluate.** Route precision/recall, stop-gate first-pass rate, escaped defects, false blocks.

## Gap summary

| Layer | Pi today | Gap | Ratchet artifact | Priority |
|---|---|---|---|---|
| Codebase | Scope only | No architecture/type/invariant enforcement | `arch` checks, `rules.tsv`, codegen/type tests | High |
| Static analysis | Per-file lint/typecheck; fix turn | No full stop gate, tests, arch, tamper, CI parity, integrity | `ratchet stop`, `checks.json`, `result.json`, CI | Critical |
| Prose | Rich prompts/skills | No rule audit, verification-skill workflow, per-prompt route, drift guard | `ratchet route`, `ratchet audit`, prompt snapshots | Medium |
| Human review | `ask_orchestrator` | No contract approval, risk routing, CODEOWNERS, review artifact | `review.json`, approval gates, required checks | High (production) |
| Platform | Pi-only | No adapters, portable event schema, renderers, fallback | CLI + adapters + renderers + `ratchet run` | Critical |

## The one-sentence definition

**Ratchet is the harness-neutral orchestration and verification framework: it gives every agent the pi orchestrator's prompt roles, plan/feedback loop, scope/budgets, and deterministic checks, then adds the trust ladder — codebase invariants, full static analysis, prose-to-check audit, and human review — with evidence CI can verify.**
