# Design: from prose to boundaries

## 1. What pstack is

pstack is a Cursor plugin with three layers:

- **One router skill** (`poteto-mode`) that matches a task to one of 23 playbooks.
- **24 principle skills** that encode engineering judgment (laziness, foundational thinking, boundary discipline, prove it works, encode lessons in structure).
- **Supporting skills** for verification (`create-verification-skill`), correction mining (`correct`), design (`architect`), review (`interrogate`), and recall.

It is packaged as an Agent Plugin (`plugin.json`, `skills/`, `agents/`) and ships a generated Claude Code copy. Its execution model is harness-specific: subagents via a `Task` tool, model roles via a config rule, Cursor-only features skipped elsewhere.

What makes pstack good is not the file format. It is the judgment: delete before adding, types over comments, prove the artifact, encode the lesson in structure. What makes it fragile is the delivery: a skill is prose the model may or may not follow, especially late in a long session.

## 2. The tweet is an enforcement ladder

The four items are not four kinds of documentation. They are four places to put a rule, ordered by how early they fire and how little they depend on the model remembering.

| Layer | Mechanism | Fails when | Token cost |
|---|---|---|---|
| 1. Codebase | One owner per state, typed boundaries, one supported API, dead code deleted | The compiler or the import graph rejects the wrong shape | Lowest |
| 2. Static analysis | Types, lint, tests, CI, formal models | A command exits non-zero | Low |
| 3. Prose | Comments, `AGENTS.md`, skills, task briefs | A human notices the model skipped it | Medium, unreliable |
| 4. Human review | Intent, product tradeoffs, irreversible actions | A reviewer catches it | Highest |

The inverse pyramid is a budget instruction: spend most effort at layer 1, then 2, then 3, and reserve layer 4 for what only a human can decide. A skill library sits at layer 3. It cannot be the foundation of a trust strategy, because nothing fails when it is ignored.

The portable unit is therefore not a skill. It is a **rule paired with its enforcing mechanism**.

## 3. What the pi orchestrator already proves

The orchestrator extension is a working enforcement kernel for one harness:

- **Tool-level gate, not prompt-level.** `scope-guard.ts` reads `.pi/scope.json` and blocks writes outside the contract. The block returns a teaching message and the subagent continues, so recovery is one turn.
- **Fail-closed.** Missing, malformed, or stale scope blocks all writes. A per-delegation file prevents a sibling delegation's scope from leaking in.
- **Counted budgets.** Exploration calls, distinct files, and turns are counted by the framework, not self-reported. Crossing a cap forces escalation.
- **Capability boundaries per role.** Scouts and reviewers get read-only tools; coders get write tools plus a required scope; bash is classified and redirected.
- **Structured output contract.** Every worker reports `## Findings`, `## Audit`, and `## Difficulty`; the orchestrator routes on the difficulty enum.
- **Plan-first gating.** A subagent must call `planSteps` before any other tool.

That is the right shape. The problem is that ~90% of the code is pi-bound: `pi.on("tool_call")`, `setActiveTools`, the subagent runner, the TUI panel, the fusion panel. None of it runs in Claude Code, OpenCode, Cursor, or Codex.

The portable 10% is the valuable part:

- `scope-guard.ts` path/glob/directory matching and fail-closed policy.
- `bash-classifier.ts` read/write classification.
- The per-delegation scope contract.
- The counted budget policy.
- The `Findings` / `Audit` / `Difficulty` contract.
- The role definitions and their tool capabilities.

## 4. The architecture: one contract, two enforcers

```
                 .ratchet/runs/<id>/contract.json
                    /                        \
        in-loop adapter                  out-of-loop gate
   (pi / Claude / OpenCode)            (git hook / CI / branch protection)
             |                                  |
        fast feedback                     authoritative
        teaches in one turn               cannot be talked around
```

The contract is the single source of truth. The in-loop adapter enforces it while the model works. CI enforces it when the change lands. If the adapter is bypassed, CI still fails. If CI is slow, the adapter saves tokens.

This is the direct answer to "bounded by physical boundaries, not asked to invigilate itself". A `tool_call` hook is policy, not physics. It can be bypassed by an unhooked tool, a subagent, an MCP call, or `--no-verify`. The physical layers are:

- an OS sandbox or container,
- a read-only checkout for read-only roles,
- git server branch protection with required checks,
- CODEOWNERS for the paths that matter,
- signed commits and protected tags for release.

Ratchet makes the cheap path correct and makes the expensive path authoritative. It does not pretend a hook is a sandbox.

## 5. Why a CLI, not another skill library

A skill is discovered by description and loaded into context. That works for judgment. It fails as a default for three reasons:

1. **Compliance decays with context length.** The instruction competes with everything else in the window.
2. **Every harness loads skills differently.** Paths, frontmatter fields, tool restrictions, and subagent APIs differ.
3. **A skill cannot fail.** There is no exit code, no artifact, no audit trail.

A CLI gives one implementation of the policy, one state format, and one exit code. The skill becomes a small manual for using the CLI. That is the correct division: prose for judgment, code for invariants.

The packaging standard already exists:

- **Agent Skills** (`SKILL.md`) is the portable procedural format, supported by pi, Claude Code, Codex, Cursor, OpenCode, and Gemini CLI.
- **Agent Plugins 1.0.0** (`plugin.json`, `skills/`, `mcp.json`) is the portable distribution format. pstack already uses its schema.
- Hooks and subagents are not portable in Agent Plugins 1.0.0. That is exactly why the policy must live in the CLI and the adapter must be thin.

## 6. What about system prompting?

The pi extension does three different jobs with its system prompt. They need different treatment.

| Prompt job | Example | Keep it? | Ratchet mechanism |
|---|---|---|---|
| Capability docs | tool syntax, specialist roster, scope shape | Yes, but generate it | Tool registry, `ratchet prompt` |
| Hard invariants | scope required, read-only, budgets, plan first | No, gate it | `ratchet guard`, `delegate()` validation |
| Judgment and routing | start cheap, escalate on difficulty, when to use fusion | Yes, as a playbook | Skill, plus outcome checks |

The rule is: **no invariant may exist only in the prompt.** A prompt line is allowed if it explains a gate, carries the current contract, or teaches a judgment call. If the prompt is the only thing preventing a bad action, that is a bug, because the prompt competes with everything else in the context window.

Concretely, migrate `prompt-builder.ts` like this:

1. Replace the static policy sections with `ratchet prompt` output: goal, role, scope, budgets, verify command. The brief is rendered from the contract, so it cannot drift from the guard.
2. Keep the adaptive routing ladder, but treat it as a playbook, not a guarantee. Enforce the outcomes: if `recommend=review`, require a reviewer delegation before `done`; if `verification=fail`, block `done` until a check passes.
3. Delete lines that repeat a gate. Keep one line that points at the gate's error message. For example, "scope required" becomes "writes outside the contract are denied; finish within scope or start a wider contract."
4. Extend `ssot-drift.test.ts` to snapshot the prompt and fail when a hard rule is added without a corresponding check or guard.
5. Measure the prompt. If it grows, the extra text is either a missing check or a missing decision procedure. Both should become code or a skill, not another paragraph.

This is the difference between a manual and a law. The skill is the manual: it tells the model how to use the boundary. The guard and CI are the law. If the model ignores the manual, the law still holds.

## 7. The four layers, made concrete

### Layer 1: codebase

- Give each piece of state one owner. Delete the second way to do it.
- Make illegal states unrepresentable. Parse external data at boundaries; trust internal types.
- Put guards at the boundary, not in every caller.
- Make the nearest example the correct one, because an agent copies what it sees.

Enforced by: the compiler, the module graph, `import/no-restricted-paths`, codegen from one schema, deleted legacy APIs.

### Layer 2: static analysis

- A lint rule whose error names the replacement.
- A test that fails when the observable behavior breaks.
- A CI job that runs the same command locally and remotely.
- A property test or a TLA+/Alloy model for a race, retry, or state machine that tests cannot reach.

Enforced by: exit codes. This is the highest token-efficiency layer: one failing line prevents a long wrong path.

### Layer 3: prose

- `AGENTS.md`: how to run, where the boundaries are, what not to touch.
- Skills: procedures for judgment-heavy work.
- Comments: only the non-obvious why.

Enforced by: nothing. Keep it short, and pair every repeated correction with a layer 1 or 2 mechanism (`ratchet audit` reports prose-only rules).

### Layer 4: human review

- Review the contract and the checks, not every diff.
- Spend human attention on intent, product tradeoffs, irreversible actions, and the design of the environment.
- Use `CODEOWNERS` and required checks to route attention.

Enforced by: branch protection, review requirements, and the decision to automate the rest.

## 8. Harness matrix

| Harness | Skill discovery | In-loop hook | Subagent/MCP gap | Authoritative layer |
|---|---|---|---|---|
| pi | `~/.pi/agent/skills`, `.agents/skills` | `tool_call` | subagents share the process; per-session routing needed | git + CI |
| Claude Code | `~/.claude/skills`, `.claude/skills` | `PreToolUse` | hooks cover subagents in current versions; verify | git + CI |
| Cursor | `.cursor/skills`, Agent Plugins | Hooks | verify subagent coverage | git + CI |
| OpenCode | `.opencode/skills`, `.agents/skills` | `tool.execute.before` | known gaps: subagent calls and MCP tools may not fire the hook | git + CI |
| T3 Code | inherits the OpenCode harness | inherits OpenCode | T3 MCP tools may bypass | git + CI |
| Codex | `.agents/skills`, `AGENTS.md` | `PreToolUse` (0.163+): Bash, apply_patch, MCP | Hosted tools do not use the local hook path; hooks need trust review | Sandbox + CI |

The OpenCode gap is not a bug in Ratchet. It is the reason the out-of-loop gate is mandatory. A security control that only covers the main agent's built-in tools is a speed bump.

## 9. Migrating the pi orchestrator

Do not rewrite it. Extract the kernel and keep the extension as the reference adapter.

**Phase 1: extract the pure policy (1-2 days).**

- Move path normalisation, glob matching, scope resolution, and the bash classifier into `lib/`.
- Remove every `@earendil-works/pi-coding-agent` import from those files.
- Add unit tests that run without pi.
- Freeze `contract.json` v1 and make `scope.json` a compatibility view.

**Phase 2: make the extension a client (1 day).**

- The `tool_call` handler maps the pi event to the normalised event and calls the same `decide()`.
- Delete the duplicated policy from `subagent-tool-guard.ts`; keep the pi-specific event plumbing.
- The TUI, plan panel, activity feed, and peek overlay stay. They are product surface, not policy.

**Phase 3: add the second harness (1 day).**

- OpenCode adapter for built-in tools.
- Claude `PreToolUse` adapter.
- `ratchet check` in CI as a required check.
- Run one real task through each adapter and record the block/allow evidence.

**Phase 4: close the loop (ongoing).**

- Port `/correct`: mine review comments and revert commits, group mistakes, and add one check per class at the highest layer that works.
- Prove each new check on the historical commit that made the mistake.
- `ratchet audit` refuses a rule with no enforcer or no proof.
- Delete prose that a check now carries.

## 10. What v0 implements

- Contract creation with role, scope, deny list, budgets, and verification commands.
- `ratchet prompt` renders the contract brief for a system prompt, from the same state the guard reads.
- Multi-harness installer with auto-detection, explicit `--harness` selection, `--user`/`--project` scope, `--dry-run`, a written manifest, and exact uninstall.
- A recorded kill switch: `ratchet disable --reason`, `ratchet enable`, visible in `status` and `doctor`.
- Write and bash guard with fail-closed scope, deny patterns, distinct-file and write budgets.
- Coarse bash classification: redirects, write verbs, `git` write subcommands, package-manager mutations, hard denies.
- Check runner with captured evidence and a `done` gate.
- `rules.tsv` audit.
- `AGENTS.md` sync with drift detection.
- Adapters for pi, OpenCode, and Claude Code, plus a git pre-commit hook.
- 17 tests, including an end-to-end contract/block/check/done proof.

## 11. What v0 does not implement

- Full shell parsing. The pi classifier is stronger and should replace the coarse one.
- MCP tool interception. Treat MCP tools as out-of-scope mutations and gate them at the server or CI.
- Subagent budget enforcement. The contract covers the parent's writes; per-child contracts are Phase 2.
- Formal verification. Add TLA+/Alloy as a check type when a state machine needs it.
- Repo history mining. `/correct` is a skill workflow in v0, not an automated miner.
- Published packaging. The CLI is local; the skill is already in Agent Skills format.

## 12. The next three moves

1. Run one real task in this repo under a contract with the OpenCode adapter installed. Record the blocked write and the passing check.
2. Add `ratchet check` to CI and make it required. That is the first boundary the model cannot edit.
3. Extract `scope-guard.ts` and `bash-classifier.ts` from the pi extension into `lib/`, delete the duplicates, and run the pi test suite against the shared kernel.
