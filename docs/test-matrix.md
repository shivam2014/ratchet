# Test matrix

Every Ratchet feature, how it is tested, and the result. `npm test` is deterministic and offline. The `test:<harness>` scripts are real model sessions and need network plus an active OpenCode Go credential.

## Unit and CLI

| Feature | File | Cases |
|---|---|---|
| Glob matching | `test/glob.test.mjs` | `**`, `*`, `?`, literal brackets, deny patterns |
| Shell classification | `test/classify.test.mjs` | reads, redirects, `rm`, `sed -i`, `cp`, `git add`, `git -C`, `git commit`, `git diff`, `apply_patch` heredoc, `git apply` heredoc, inline interpreters, hard denies, package managers |
| Decision policy | `test/decide.test.mjs` | allow/deny, scope, deny list, case-folded deny, symlink escape, read-only, read without contract, write without path, budgets, bash hard deny, bash redirect, unresolved bash |
| Contract state | `test/contract.test.mjs` | check detection, contract defaults, path normalization, real paths, version rejection, session resolution |
| Rule table | `test/rules.test.mjs` | valid rows, prose warnings, missing enforcer/proof, unknown layer, malformed rows |
| AGENTS.md sync | `test/agents-md.test.mjs` | append, replace, idempotent, drift check |
| Check runner | `test/checks.test.mjs` | pass, fail, timeout, empty |
| Filesystem helpers | `test/fsx.test.mjs` | root discovery, relative/absolute paths, JSON round trip, slug, timestamp |
| CLI end to end | `test/e2e.test.mjs` | init, contract, guard allow/deny, no contract, budget, audit, sync, install opencode/claude/codex, Claude hook format, dry run |
| pi adapter lifecycle | `test/pi-adapter.test.mjs` | prompt auto contract and brief, tool deny, post-check context, stop block and allow, no-op outside a repo |

Total: 191 tests, all passing.

```bash
npm test
```

The CLI stress matrix runs the real binary through 26 edge cases, each in its own process. It stays outside `npm test` for speed.

```bash
npm run test:stress
```

## Harness end-to-end

| Harness | Script | Result | What was exercised |
|---|---|---|---|
| Codex 0.163 | `npm run test:codex` | PASS | Native `apply_patch` allow inside through the model; deny outside through the installed hook; check + done; OpenCode Go provider via `codex-go` |
| Claude Code 2.1.258 | `npm run test:claude` | PASS | Isolated `CLAUDE_CONFIG_DIR` with only the Ratchet hook; `Write` allow and deny; check + done; OpenCode Go provider via `claude-go` |
| pi 1.3.0 | `npm run test:pi` | PASS | Only the Ratchet extension loaded; auto contract from the prompt; `write` allow and deny; check + done; OpenCode Go provider |
| OpenCode 2.0.32 | `npm run test:opencode` | PASS | v2 plugin API; `write` allow and deny; check + done |
| T3 Code | OpenCode provider plugin | OpenCode adapter test; provider loading not automated | Tool guard and post-write checks; no T3-native prompt/stop yet |
| Cursor | none | Not tested | Not installed on this machine; no adapter claimed |

### Isolation used

- Codex: `CODEX_HOME=~/.codex-ratchet-test`, one `PreToolUse` hook, no plugins, no notify, no inline hooks.
- Claude: `CLAUDE_CONFIG_DIR=~/.claude-ratchet-test`, one `PreToolUse` hook, no plugins.
- pi: `--no-extensions --extension adapters/pi/ratchet.ts --no-skills --no-context-files --no-mcp`.
- OpenCode: project `.opencode/plugins/ratchet.js` only, `--standalone` server.

## Bugs the tests found

Each was fixed at the source and has a test or a documented proof.

| Bug | Caught by | Fix |
|---|---|---|
| `write` with no resolvable path was allowed | `decide` unit test | Fail closed for explicit write tools |
| Reads denied when no contract existed | `decide` unit test | Classify the tool before requiring a contract |
| `git -C src add a.ts` was invisible | `classify` red-green | Skip git global options, rebase paths onto `-C` |
| `rm -f src/a.ts` skipped its operand | `classify` test | `-f` is not a value flag |
| Codex `apply_patch <<'PATCH'` via Bash was a read | Codex e2e | `patchTargets()` extracts patch body paths |
| Codex adapter spawned `ratchet` from PATH and failed | Codex e2e | Fail closed, then resolve the CLI relative to the adapter |
| OpenCode 2.x silently rejected the v1 plugin | OpenCode e2e | Rewrote the adapter to the v2 `id` + `setup` + `ctx.tool.hook` contract; v1 file kept for older versions |
| OpenCode v2 `ctx.directory` is undefined | OpenCode probe | Use `ctx.location.directory` |
| Claude hooks used `ratchet` from PATH | Claude e2e | Installer writes the absolute `node ratchet.mjs guard` command |
| Claude sent the Go key as a bearer token | Claude smoke test | Use `ANTHROPIC_API_KEY` (x-api-key), not `ANTHROPIC_AUTH_TOKEN` |
| `.env` deny did not match `.ENV` on a case-insensitive filesystem | Stress matrix | Match deny entries case-insensitively; keep scope exact |
| A symlink inside the scope wrote outside it | Stress matrix | Resolve real paths before the scope check |
| Two sessions shared the global current contract | Stress matrix and route test | Resolve the contract by session, then fall back to a manual contract |

## Still manual or untested

- Interactive hook trust: Codex `/hooks` and Claude's trust prompt were bypassed with flags in automation.
- MCP tool classification: unknown tools are allowed and left to CI.
- Subagent tool calls: not exercised in any harness.
- Cursor: no adapter or test.
- Formal verification: not implemented as a check type.
