# Ratchet

A harness-neutral contract and verification gate for coding agents.

The agent does not decide when work is done. A written contract defines the boundary, a machine check produces evidence, and `ratchet done` refuses to close without it.

```
ratchet task start --role coder --goal "add retry to the uploader" --scope "src/upload/**"
# agent works; writes outside scope are denied
ratchet check     # runs the repo's own checks
ratchet done      # refuses without passing evidence
```

## Why

Agent instructions decay. A `SKILL.md` or `AGENTS.md` line is a suggestion the model may skip at turn 40. A type error, a failing lint rule, a test, a denied write, or a red CI check is not.

Ratchet puts the repeatable part of the workflow outside the model loop:

- **One contract** per task: goal, role, writable paths, budgets, verification commands.
- **Two enforcers**: an in-loop adapter (fast feedback) and git/CI (authoritative).
- **One rule table**: every correction is paired with the mechanism that makes it impossible to repeat.

## Install

```bash
git clone <this repo> ~/ratchet
ln -s ~/ratchet/bin/ratchet.mjs /usr/local/bin/ratchet   # or add ~/ratchet/bin to PATH
ratchet init
```

`ratchet init` detects `package.json` scripts (`check`, `lint`, `typecheck`, `test`, `build`) and writes `.ratchet/config.json`.

## Harness adapters

| Harness | Adapter | In-loop strength |
|---|---|---|
| pi | `adapters/pi/ratchet.ts` | strong: `tool_call` hook |
| Claude Code | `adapters/claude/` + `settings.json` | strong: `PreToolUse` |
| OpenCode / T3 Code | `adapters/opencode/ratchet.js` | partial: built-in tools only; subagents and MCP may bypass |
| Cursor | same `PreToolUse` shape as Claude | strong, verify current hook config |
| Codex | no portable pre-tool hook assumed | out-of-loop only: sandbox + CI |
| Anything else | `ratchet guard` on stdin | depends on the harness |

The adapter is deliberately thin. It normalises one tool call to JSON, calls `ratchet guard`, and blocks on exit 2. All policy lives in the CLI, so every harness gets the same rules.

```json
{"harness":"opencode","tool":"write","input":{"path":"src/a.ts"},"cwd":"/repo"}
```

`ratchet guard` returns `{"allow":true|false,"reason":"...","paths":[...]}` and exits 0 or 2. `--format claude` emits the `PreToolUse` JSON shape.

## Commands

| Command | Does |
|---|---|
| `ratchet init` | Detect checks, write `.ratchet/config.json` and `rules.tsv` |
| `ratchet task start` | Write a contract and make it current |
| `ratchet task status` | Show scope, budgets, and check state |
| `ratchet guard` | Enforce one normalised tool event from stdin |
| `ratchet check` | Run the contract's verification commands, save evidence |
| `ratchet done` | Refuse without passing evidence; write `result.json` |
| `ratchet audit` | Validate every rule has a machine enforcer and a proof |
| `ratchet doctor` | Check the install |
| `ratchet sync` | Write the managed `AGENTS.md` block; `--install` adds the OpenCode and git hooks |

## State

```
.ratchet/
  config.json
  rules.tsv                  rule -> layer -> enforcer -> proof
  current                    active run id
  runs/<id>/
    contract.json
    events.jsonl             every allow/deny, append-only
    checks.json
    result.json
```

Contracts and events are plain JSON so any harness, script, or CI job can read them. Nothing is stored in a model's context.

## The rule table

`ratchet audit` fails when a rule claims a machine layer but names no enforcer or no proof. Prose-only rules are allowed but reported as unchecked.

```
rule                 layer  enforcer                         proof
no-floating-promises lint   eslint @typescript-eslint/...    commit 4f2a1c9
scope-writes         code   ratchet guard                    test/e2e.test.mjs
```

The proof matters. A check that has never failed on a real past mistake is a guess.

## CI

```yaml
- run: node bin/ratchet.mjs check
```

Make that job a required check in branch protection. That is the layer the model cannot talk around.

## What this is not

- Not a replacement for pstack. pstack is a library of engineering playbooks. Ratchet is the enforcement kernel those playbooks can call.
- Not a sandbox. A hook is policy, not a boundary. For a real boundary, run the agent in a container or a read-only checkout and let CI be the authority.
- Not a planner. The contract is small on purpose.

## Design notes

See [docs/design.md](docs/design.md) for the pstack analysis, the enforcement pyramid, the pi orchestrator extraction plan, and the harness matrix.
