# Testing Ratchet

Tests follow the pstack rules: one observable behavior per test, no assertions on internals, and every regression gets a check that fails on the old code.

## Layers

| Layer | Files | What it proves |
|---|---|---|
| Pure policy | `test/glob.test.mjs`, `test/classify.test.mjs` | Path matching and shell classification |
| Decision | `test/decide.test.mjs` | Allow/deny, budgets, read-only, fail-closed paths |
| State | `test/contract.test.mjs`, `test/agents-md.test.mjs`, `test/rules.test.mjs` | Contract loading, check detection, rule table, session resolution |
| End to end | `test/e2e.test.mjs` | CLI init, contract, guard, check, done, install, disable |
| CLI stress | `test/stress.mjs` | Malformed events, scope, traversal, deny lists, budgets, stop, tamper, symlinks, sessions |

191 tests. Run them with:

```bash
npm test
```

Or run the whole gate the way CI does:

```bash
node bin/ratchet.mjs check
```

## The two bugs the unit layer caught

Both were fail-open or fail-closed behavior that the e2e suite never hit.

### 1. Reads were denied when no contract existed

`decide()` loaded the contract before checking the tool kind. A read event with no active contract returned "No active task contract" even though reads never mutate. The e2e suite never sent a read with no contract.

Fix: classify the tool first; allow reads; then require a contract for mutations.

### 2. A write with no resolvable path was allowed

`decide()` treated every unresolved mutation as "coarse bash" and allowed it. A malformed `write` event with no path therefore passed the guard. The e2e suite always sent a path.

Fix: fail closed for explicit `write` tools; keep the coarse path only for `bash`, where the command may legitimately be a build step like `npm install`.

## Proof that the tests catch the old code

Run the new `test/decide.test.mjs` against the pre-fix implementation:

```text
not ok 1 - decide: reads are allowed without a contract
not ok 7 - decide: write with no path is denied
# tests 12
# pass 10
# fail 2
```

Against the fixed implementation:

```text
# tests 12
# pass 12
# fail 0
```

This is the pstack `/correct` proof: a check that has never failed on a real past mistake is a guess.

## The third bug: strict red-green

`git -C src add a.ts` was invisible to the classifier because it read `tokens[i + 1]` as the subcommand. `-C` is a global option, so the write was missed.

Test first:

```text
not ok 7 - classify: git -C resolves the path against the directory
# tests 14
# pass 13
# fail 1
```

Then the fix: skip git global options, read the real subcommand, and rebase relative paths onto the `-C` directory.

```text
# tests 14
# pass 14
# fail 0
```

This one was written before the fix, so it is a real red-green cycle, not a retrospective proof.

## Rule table

`.ratchet/rules.tsv` pairs each rule with its enforcing test:

```text
rule                            layer  enforcer
write-target-required           code   lib/decide.mjs + test/decide.test.mjs
reads-allowed-without-contract  code   lib/decide.mjs + test/decide.test.mjs
bash-flag-value-parsing         code   lib/classify.mjs + test/classify.test.mjs
git-dash-c-path-resolution      code   lib/classify.mjs + test/classify.test.mjs
opencode-plugin-path            code   lib/harnesses.mjs + test/e2e.test.mjs
glob-brackets-literal           code   lib/glob.mjs + test/glob.test.mjs
```

`ratchet audit` fails if a row has no enforcer or no proof.

## What is not covered yet

- `checks.mjs` timeout behavior. Add a test with a sleeping command and a 50 ms timeout.
- Harness detection. It depends on the machine; test the pure merge and path logic instead.
- Cursor adapter. No installer yet.
- Adapter conformance. Each harness should run the same allow/deny fixture set; today only the CLI contract is shared.
