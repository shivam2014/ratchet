# Ratchet

**A contract and verification gate for coding agents.**

The agent does not decide when the work is done. A written contract defines the boundary, a machine check produces the evidence, and `ratchet done` refuses to close without it.

[![ci](https://github.com/shivam2014/ratchet/actions/workflows/ci.yml/badge.svg)](https://github.com/shivam2014/ratchet/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node 20+](https://img.shields.io/badge/node-20%2B-brightgreen.svg)](package.json)

## See it work

```console
$ ratchet task start --role coder --goal "add hello file" --scope "src/**"
scope:   src/**
verify:  npm run check

$ echo '{"harness":"demo","tool":"write","input":{"path":"lib/leak.txt"}}' | ratchet guard
{"allow":false,"reason":"lib/leak.txt is outside scope [src/**]. ..."}
exit=2

$ ratchet check
PASS  verify-1  (0.2s)

$ ratchet done
DONE  <run-id>
checks: verify-1=pass
```

`npm run demo` reproduces that sequence end to end in a temporary repo, including the blocked write.

## Why

Agent instructions decay. A `SKILL.md` or `AGENTS.md` line is a suggestion the model may skip at turn 40. A type error, a failing lint rule, a test, a denied write, or a red CI check is not.

Ratchet puts the repeatable part of the workflow outside the model loop:

- **One contract per task.** Goal, role, writable paths, budgets, verification commands.
- **Two enforcers.** An in-loop adapter for fast feedback; git and CI for the authority.
- **One rule table.** Every correction is paired with the mechanism that makes it impossible to repeat.

## The contract

The whole policy is a small JSON file, readable by any harness, script, or CI job:

| Field | What it means |
|---|---|
| `scope` | Writable globs. A path that does not match is denied. |
| `deny` | Always blocked, even inside scope. |
| `budgets` | Caps on distinct files and writes. Crossing a cap denies. |
| `verify` | Commands `ratchet check` runs. `ratchet done` refuses unless all exit 0. |
| `role` | Capability profile: coder, reviewer, writer, or a repo-defined role. |
| `goal` | Audit label. |

A missing, malformed, or stale contract fails closed: writes are denied until a valid contract exists.

## How it works

```text
                 .ratchet/runs/<id>/contract.json
                    /                        \
        in-loop adapter                  out-of-loop gate
   (pi / Claude / OpenCode)            (git hook / CI / branch protection)
             |                                  |
        fast feedback                     authoritative
        teaches in one turn               cannot be talked around
```

Ratchet participates at three points only:

1. **Before the loop.** `ratchet prompt` renders a deterministic Markdown brief from `contract.json`. It is string formatting, not generation.
2. **During the loop.** The adapter sends one tool call as JSON to `ratchet guard`, which returns allow or deny from path, scope, and budget rules.
3. **After the loop.** `ratchet check` runs the repo's own commands and records exit codes; `ratchet done` reads that evidence and refuses to close if any check failed.

The adapter is deliberately thin. It normalises one tool call to JSON, calls `ratchet guard`, and blocks on exit 2. All policy lives in the CLI, so every harness gets the same rules.

```json
{"harness":"opencode","tool":"write","input":{"path":"src/a.ts"},"cwd":"/repo"}
```

`ratchet guard` returns `{"allow":true|false,"reason":"...","paths":[...]}` and exits 0 or 2. `--format claude` emits the `PreToolUse` JSON shape.

## Harnesses

```bash
ratchet install --harness pi,claude,opencode,t3,codex --project --yes
ratchet status
```

| Harness | What `install` writes | In-loop strength |
|---|---|---|
| pi | `.pi/extensions/ratchet.ts`, `.pi/skills/ratchet-mode` | strong: `before_agent_start`, `tool_call`, `tool_result`, `agent_end` hooks |
| Claude Code | `.claude/settings.json` PreToolUse hook, `.claude/skills/ratchet-mode` | strong: `PreToolUse` |
| OpenCode | `.opencode/plugins/ratchet.js` (v2 API; v1 fallback), `.agents/skills/ratchet-mode` | partial: built-in tools only; subagents and MCP may bypass |
| T3 Code | OpenCode provider plugin: tool guard and post-write checks; git/CI stop | partial: no T3-native prompt/stop yet |
| Codex | `.codex/hooks.json` PreToolUse hook, `.agents/skills/ratchet-mode` | strong for `Bash`, `apply_patch`, and MCP; hosted tools are not covered; requires hook trust |
| Cursor | not auto-installed yet; same `PreToolUse` shape as Claude | strong, verify current hook config |

Global paths are `~/.pi/agent/extensions`, `~/.claude/settings.json`, `~/.config/opencode/plugins`, `~/.codex/hooks.json`, and `~/.agents/skills`.

`--project` is the default. Use `--user` for global installs. Omit `--harness` in a terminal and Ratchet prompts with the harnesses it detected. `--dry-run` prints the plan without writing. `ratchet uninstall --harness ...` reverses only what the manifest says it installed.

## Install

```bash
git clone https://github.com/shivam2014/ratchet ~/ratchet
cd ~/ratchet
npm link
ratchet init
```

`npm link` puts the `ratchet` binary on your PATH. If you would rather not use it:

```bash
ln -s "$PWD/bin/ratchet.mjs" ~/.local/bin/ratchet
```

`ratchet init` detects `package.json` scripts (`check`, `lint`, `typecheck`, `test`, `build`) and writes `.ratchet/config.json`.

## Quick start

```bash
ratchet task start --role coder --goal "add retry to the uploader" --scope "src/upload/**"
# the agent works; writes outside scope are denied
ratchet check
ratchet done
```

`ratchet done` releases the contract. A new task starts with a new contract.

## Commands

| Command | Does |
|---|---|
| `ratchet init` | Detect checks, write `.ratchet/config.json` and `rules.tsv` |
| `ratchet install` | Install adapters and skills for one or more harnesses |
| `ratchet uninstall` | Remove only the files Ratchet recorded |
| `ratchet status` | Show the contract, installed harnesses, and enabled/disabled state |
| `ratchet disable` / `enable` | Kill switch for the guard, with a recorded reason |
| `ratchet task start` | Write a contract and make it current; `--pstack` gates source behind the plan and sketch artifacts; `--bend` gates Bend code behind `LAWS.bend` |
| `ratchet task status` | Show scope, budgets, and check state |
| `ratchet prompt` | Render the contract brief to inject into a system prompt |
| `ratchet guard` | Enforce one normalised tool event from stdin |
| `ratchet check` | Run the contract's verification commands, save evidence |
| `ratchet report` | Show the allow/deny trail for the current run; `--json` for machine output |
| `ratchet done` | Refuse without passing evidence; write `result.json` |
| `ratchet audit` | Validate every rule has a machine enforcer and a proof |
| `ratchet doctor` | Check the install; `--harness codex,claude` verifies hooks, trust, and no-op behaviour |
| `ratchet sync` | Write the managed `AGENTS.md` block; `--install` adds the OpenCode and git hooks |

## Evidence

- **234 deterministic unit and CLI tests**, no network, all passing. `npm test`
- **32 CLI stress cases**, each in its own process. `npm run test:stress`
- **Real sessions** in Codex 0.163, Claude Code 2.1.258, pi 1.3.0, OpenCode 2.0.32, and T3 Code Nightly. The per-harness scripts drive real model sessions and need network plus a provider key; the unit and CLI suite does not.
- **13 rules** in `rules.tsv`, each with a machine enforcer and a proof. `ratchet audit`
- **CI** runs the suite, the stress matrix, and the rule audit on every push. Make it a required check in branch protection; that is the layer the model cannot talk around.
- **Bugs the tests caught**, recorded in [`docs/test-matrix.md`](docs/test-matrix.md): a `git -C` path escape, an `rm -f` operand skip, a Codex patch heredoc misclassified as a read, and others.

## Design principles

- **No model backend.** Ratchet is a Node CLI with no model, no API key, and no network call. It does not generate replies and does not treat the model's prose as evidence.
- **Fail closed.** Missing or malformed contracts block writes, and contracts are resolved per session so a sibling delegation cannot inherit another's scope.
- **Evidence over prose.** The model's "done" message is not proof. The exit code of the repo's own checks is.
- **Policy is not a sandbox.** A hook can be bypassed by an unhooked tool, a subagent, an MCP call, or `--no-verify`. The authority is git and CI: a pre-commit hook for local feedback, required checks and branch protection for the real boundary.
- **One rule table.** `ratchet audit` fails when a rule claims a machine layer but names no enforcer or no proof. A check that has never failed on a real past mistake is a guess.

## State

```text
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

## Status

v0.2.0. Implemented: explicit contracts, `guard`, `check`, `done`, `audit`, installers for five harnesses, a git pre-commit hook, and CI. Next: prompt routing and stop hooks, so the normal case does not need `ratchet task start`.

The current release is prompt-blind: the contract is created explicitly before the turn. The planned `ratchet route` reads the prompt locally to choose a contract profile and a skill shortlist; it still has no model, makes no network call, and stores a hash rather than the raw prompt by default. See [`docs/vision.md`](docs/vision.md).

## What this is not

- **Not a replacement for pstack.** pstack is a library of engineering playbooks. Ratchet is the enforcement kernel those playbooks can call.
- **Not a sandbox.** A hook is policy, not a boundary. For a real boundary, run the agent in a container or a read-only checkout and let CI be the authority.
- **Not a planner.** The contract is small on purpose.

## Docs

- [`docs/vision.md`](docs/vision.md): prompt to route to contract to guard to stop gate to CI.
- [`docs/design.md`](docs/design.md): the enforcement ladder, the pi orchestrator analysis, and the harness matrix.
- [`docs/routing.md`](docs/routing.md): routing research, the cascade design, and the evaluation plan.
- [`docs/universal-integration.md`](docs/universal-integration.md): the normalised lifecycle protocol and the adapter ladder.
- [`docs/hooks.md`](docs/hooks.md): the adapter contract and its limits.
- [`docs/flow.html`](docs/flow.html): the full run, step by step, with the contract fields and the CI layer.
- [`docs/test-matrix.md`](docs/test-matrix.md): every feature, how it is tested, and the bugs the tests caught.
- [`docs/pi-test.md`](docs/pi-test.md), [`docs/claude-test.md`](docs/claude-test.md), [`docs/opencode-test.md`](docs/opencode-test.md), [`docs/codex-test.md`](docs/codex-test.md): per-harness records.
- [`docs/t3.md`](docs/t3.md): the T3 Code provider-level integration and its limits.
- [`docs/pstack.md`](docs/pstack.md), [`docs/bend.md`](docs/bend.md): optional gates for pstack skills and Bend proofs.

## License

MIT. See [`LICENSE`](LICENSE).
