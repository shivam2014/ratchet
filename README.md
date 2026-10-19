# Ratchet

A harness-neutral contract and verification gate for coding agents.

The agent does not decide when work is done. A written contract defines the boundary, a machine check produces evidence, and `ratchet done` refuses to close without it.

```
ratchet task start --role coder --goal "add retry to the uploader" --scope "src/upload/**"
# agent works; writes outside scope are denied
ratchet check     # runs the repo's own checks
ratchet done      # refuses without passing evidence
```

## No model backend

Ratchet is a Node CLI with no model, no API key, and no network call. It does not generate replies and it does not treat the model's prose as evidence.

The v0 CLI is prompt-blind. The planned `ratchet route` hook reads the prompt locally to choose a contract profile and a skill shortlist; it still has no model, makes no network call, and stores a hash rather than the raw prompt by default. See [docs/vision.md](docs/vision.md).

The split is:

| Owner | Owns |
|---|---|
| Harness (pi, Claude Code, OpenCode/T3) | Prompt assembly, model choice, inference, tool dispatch |
| Model | Reasoning and the response text |
| Ratchet | Contract state, allow/deny on tool calls, check evidence |
| Repo + CI | The commands that decide whether the change is good |

Ratchet participates at three points only:

1. **Before the loop**: `ratchet prompt` renders a deterministic Markdown brief from `contract.json`. It is string formatting, not generation.
2. **During the loop**: the adapter sends one tool call as JSON to `ratchet guard`. The guard returns allow or deny from path, scope, and budget rules.
3. **After the loop**: `ratchet check` runs the repo's own commands and records exit codes; `ratchet done` reads that evidence.

Planned for the automatic flow: a `UserPromptSubmit` hook calls `ratchet route` to create the contract and inject the brief, and a `Stop` hook calls `ratchet stop` to run the checks before the model can finish. Then the user does not run `ratchet task start` for the normal case. The rest of this README describes v0, where the contract is created explicitly.

If you later want model-assisted judgment, it belongs in an optional `ratchet judge` command whose output is an advisory artifact, not the authority. The deterministic checks stay the gate.

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

## Install for your harnesses

```bash
ratchet install --harness pi,claude,opencode,t3,codex --project --yes
ratchet status
```

`--project` is the default. Use `--user` for global installs. Omit `--harness` in a terminal and Ratchet prompts with the harnesses it detected. `--dry-run` prints the plan without writing. `ratchet uninstall --harness ...` reverses only what the manifest says it installed.

| Harness | What `install` writes | In-loop strength |
|---|---|---|
| pi | `.pi/extensions/ratchet.ts`, `.pi/skills/ratchet-mode` | strong: `tool_call` hook |
| Claude Code | `.claude/settings.json` PreToolUse hook, `.claude/skills/ratchet-mode` | strong: `PreToolUse` |
| OpenCode | `.opencode/plugins/ratchet.js` (v2 API; v1 fallback), `.agents/skills/ratchet-mode` | partial: built-in tools only; subagents and MCP may bypass |
| T3 Code | the same OpenCode plugin and skill | partial: same gap as OpenCode |
| Codex | `.codex/hooks.json` PreToolUse hook, `.agents/skills/ratchet-mode` | strong for `Bash`, `apply_patch`, and MCP; hosted tools are not covered; requires hook trust |
| Cursor | not auto-installed yet; same `PreToolUse` shape as Claude | strong, verify current hook config |

Global paths are `~/.pi/agent/extensions`, `~/.claude/settings.json`, `~/.config/opencode/plugins`, `~/.codex/hooks.json`, and `~/.agents/skills`.

## Tested

| Harness | Command | Status | Notes |
|---|---|---|---|
| Codex 0.163 | `npm run test:codex` | PASS | Native and Bash-heredoc `apply_patch`; OpenCode Go via `codex-go` |
| Claude Code 2.1.258 | `npm run test:claude` | PASS | Isolated config with one hook; `Write` allow and deny; OpenCode Go via `claude-go` |
| pi 1.3.0 | `npm run test:pi` | PASS | Only the Ratchet extension; `write` allow and deny |
| OpenCode 2.0.32 | `npm run test:opencode` | PASS | v2 plugin API; `write` allow and deny |
| Cursor | none | Not tested | Not installed; no adapter claimed |

`npm test` runs 75 deterministic unit and CLI tests. The harness scripts need network and an active OpenCode Go credential.

Ratchet can enforce the actual pstack skills: install them as Agent Skills, then start a task with `--pstack` to gate source writes behind the `/poteto-mode` plan and the `/architect` sketch. See [docs/pstack.md](docs/pstack.md).

Ratchet can also use [Bend](https://bend-lang.com) as a proof oracle: `--bend` gates `**/*.bend` writes behind `LAWS.bend` and verifies with `bend PROOF.bend --check-only`. See [docs/bend.md](docs/bend.md).

See [docs/test-matrix.md](docs/test-matrix.md) for the full feature-to-test map and the bugs the tests caught.

The adapter is deliberately thin. It normalises one tool call to JSON, calls `ratchet guard`, and blocks on exit 2. All policy lives in the CLI, so every harness gets the same rules.

```json
{"harness":"opencode","tool":"write","input":{"path":"src/a.ts"},"cwd":"/repo"}
```

`ratchet guard` returns `{"allow":true|false,"reason":"...","paths":[...]}` and exits 0 or 2. `--format claude` emits the `PreToolUse` JSON shape.

## Kill switch

```bash
ratchet disable --reason "false positive on generated files"
ratchet enable
ratchet status
```

`disable` writes `.ratchet/disabled.json`. The guard allows tool calls and records that it was disabled; `ratchet check` and `ratchet done` still work. `status` and `doctor` show the reason loudly. This is for a bad guard, not for a failing check.

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
| `ratchet done` | Refuse without passing evidence; write `result.json` |
| `ratchet audit` | Validate every rule has a machine enforcer and a proof |
| `ratchet doctor` | Check the install; `--harness codex,claude` verifies hooks, trust, and no-op behavior |
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

See [docs/vision.md](docs/vision.md) for the product vision: prompt → route → contract → guard → stop gate → CI. See [docs/routing.md](docs/routing.md) for the routing research, the cascade design, and the evaluation plan. See [docs/design.md](docs/design.md) for the pstack analysis, the enforcement pyramid, the pi orchestrator extraction plan, and the harness matrix. See [docs/test-matrix.md](docs/test-matrix.md) for the feature-to-test map. Per-harness records: [Codex](docs/codex-test.md), [Claude](docs/claude-test.md), [pi](docs/pi-test.md), [OpenCode](docs/opencode-test.md). See [docs/hooks.md](docs/hooks.md) for the adapter contract and its limits.
