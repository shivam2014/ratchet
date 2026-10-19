# Bend as an oracle check

Bend 2.x is a language with `LAWS.bend` (human claims) and `PROOF.bend` (machine-checked proofs). Its checker prints `ALL PROOFS CHECK` or `SOME PROOFS FAIL`. Ratchet can run that checker as a deterministic check and gate Bend code behind the law file.

This is the strongest layer-2 check Ratchet can carry today: a real proof, not a test or a prompt.

## Install

The official installer downloads a pinned release from GitHub, verifies its SHA-256, and installs under `BEND_HOME` with no sudo and no shell edits:

```bash
curl -fsSL https://bend-lang.com/install.sh |
  BEND_HOME="$HOME/.bend" BEND_NO_TELEMETRY=1 sh
export PATH="$HOME/.bend/bin:$PATH"
bend version
```

Pin the version in CI. `--verdict` needs Lean 4.34 (or a built `$BENDTT` kernel); without it, use `--check-only`, which is the Bend2 checker.

## Use with Ratchet

```bash
BEND_BIN="$HOME/.bend/bin/bend" ratchet task start \
  --role coder \
  --goal "prove the ledger invariant" \
  --scope "**/*.bend" \
  --bend

ratchet check
ratchet done
```

`--bend` does three things:

1. Adds the gate **`LAWS.bend` before any `**/*.bend` write**. The human writes the law; the agent writes the proof and code.
2. Adds `LAWS.bend` and `PROOF.bend` to the contract scope.
3. Adds `<BEND_BIN or bend> PROOF.bend --check-only` to the verification commands.

Override the binary with `BEND_BIN` when it is not on `PATH`. The contract records the absolute command, so the check is reproducible.

## Why it fits the pyramid

| Layer | Bend provides |
|---|---|
| 1. Codebase | dependent types, linearity, no shared mutable state by default |
| 2. Static analysis | a proof checker that returns an exit code in under a second |
| 3. Prose | `LAWS.bend` states the intent the humans actually care about |
| 4. Human review | humans choose the laws; they do not review every proof step |

`LAWS.bend` is `AGENTS.md` backed by proof. That is the same thesis as Ratchet, applied to a language.

## Example

`examples/bend/LAWS.bend`:

```python
import Base

law add_zero:
  for x: Nat
  {Nat.add(x, 0n) == x : Nat}
```

`examples/bend/PROOF.bend`:

```python
import Base
import ./LAWS.bend as Laws

def Laws.add_zero(x):
  match x:
    case 0n:
      {==}
    case 1n+p:
      %Laws.add_zero(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}
```

```bash
bend PROOF.bend --check-only
# ALL PROOFS CHECK
```

Break the induction step and it becomes `SOME PROOFS FAIL`; Ratchet records the failure, and `ratchet done` refuses.

## Limits

- **Bend verifies Bend.** It does not check TypeScript, Python, or JavaScript. Use it for a Bend core or a model; it is not a linter for an existing repo.
- `--verdict` uses a Lean-proven kernel, but the parser and translation into that kernel are not proven. Treat `--check-only` as a strong check, not a mathematical guarantee about the parser.
- Bend 2 is young: no tactics or proof search, F32 is axiomatic, no Windows, one C file per program, one GPU. Pin the version and expect sharp edges.
- A proof only proves the law you wrote. It cannot tell you the law is the right one; that stays human.
- Proof effort is real. Budget for it on invariants that matter, not on every function.
