---
name: ratchet-mode
description: 'Run every coding task against a written contract and a machine check. Use when the repo has a .ratchet directory, when the user says /ratchet-mode, or when work must be verified before "done". Enforces scope, budgets, checks, and evidence.'
license: MIT
metadata:
  tags: "verification, scope, static-analysis, workflow"
  category: "engineering"
---

# ratchet-mode

The work is not done when the model says so. It is done when the contract is satisfied and the check exits 0.

## Persistence

These rules apply to every coding task for the rest of the session. They do not expire when the topic changes. Turn them off only when the user says "stop ratchet mode". Confirm in one line, then return to the default style.

If the repo has a `.ratchet` directory, this skill applies without being named.

## The loop

1. Read `.ratchet/config.json`. If it does not exist, run `ratchet init`.
2. Start a contract before touching files.
   `ratchet task start --role coder --goal "<one line>" --scope "<glob>" --verify "<command>"`
3. Work inside the contract. A blocked write is a boundary, not a suggestion.
4. Run `ratchet check`. Fix the first failure. Repeat.
5. Run `ratchet done`. It refuses without passing check evidence.

If the task cannot fit the contract, stop and start a new one with a wider scope. Do not work around the guard.

## Rules

### 1. The contract is the boundary

The contract names the goal, the role, the writable paths, the budgets, and the verification command. The adapter denies writes outside it.

Do not edit `.ratchet/`, the guard, or the check script to make a failure disappear. Do not use `--no-verify`, `--force`, or an equivalent bypass. If the contract is wrong, say what is wrong and start a new one.

### 2. Climb the enforcement ladder before writing prose

When a mistake repeats, fix it at the highest level that works:

1. **Codebase**: remove the second way to do it. One owner per state, one supported API, typed boundaries.
2. **Types and lint**: make the bad state unrepresentable, or fail the build with an error that names the fix.
3. **Tests and CI**: assert the behavior a user can observe. Make the check run on every change.
4. **Prose**: comments, AGENTS.md, skills. Only for judgment that no machine can check.

Never add a rule to prose when a type, lint rule, test, or guard can carry it. A rule that nothing enforces is a wish.

### 3. Every new rule carries its proof

Add one row to `.ratchet/rules.tsv`:

```
rule	layer	enforcer	proof
```

`layer` is one of `code`, `type`, `lint`, `test`, `ci`, `runtime`, `prose`. `enforcer` is the file, command, or check that fails. `proof` is the commit, diff, or test name where the old mistake actually fails the new check.

A new check that has never failed on a real past mistake is unproven. Replay the mistake or do not claim the rule.

### 4. Verify the artifact, not the proxy

`ratchet check` is necessary, not sufficient. After it passes, exercise the real path once: run the CLI, open the page, call the endpoint, read the file. A green check that never touched the changed behavior is not evidence.

Capture what you observed in the reply: the command, the input, the output.

### 5. Escalate instead of widening silently

When a write is blocked or a budget is exhausted, do not retry the same call. Choose one:

- Finish within scope.
- Ask for a new contract with a named wider scope and the reason.
- Escalate the task to a stronger model or a human.

State the blocker and the smallest scope that would unblock it.

### 6. One verifiable unit at a time

Break multi-step work into units that each end in a check. Finish one, run the check, then start the next. Do not stack unverified changes.

### 7. The agent owns the result

A passing subagent report is not evidence. Read the diff, run the check yourself, and write your own summary. "The subagent said it passed" is not a verification.

### 8. Report the evidence, not the effort

The final reply names:

- the contract id and goal,
- the files changed and why,
- the check command and its result,
- what you exercised beyond the check,
- anything still open.

No "all tests pass" without the command and the exit status. No "should work" for something you could run.

## When to break the rules

1. **Read-only investigation**: use `--read-only`, no scope needed. The contract still records what was read and changed.
2. **Irreversible action ahead** (force push, deploy, data deletion, migration): pause and confirm. Safety outranks the loop.
3. **The repo has no checks**: say so, run `ratchet init`, and add the cheapest real check before claiming done. Do not fake one.
4. **The guard is wrong**: stop. Report the false positive with the exact command and path. Fix the guard in its own change with a regression test. Do not disable it for the task.

## Pre-send check

Before replying, delete:

1. Any claim that is not backed by a command, a file, or an observation from this session.
2. Any "done" that has no `ratchet done` evidence or an equivalent check.
3. Any instruction you added to prose that a type, lint, test, or guard could enforce.
4. Any retry of a blocked path under a different spelling.
5. Any summary that hides a failed check or an open blocker.

Then answer: if the reader reads only the first line and the last line, do they know what changed and what proves it?

If yes, send.
