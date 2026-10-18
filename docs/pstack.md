# Enforcing pstack skills

pstack is a library of prose skills. An agent can ignore them, and nothing fails. Ratchet turns the observable parts into artifacts and gates so the order is enforced on the model, not requested.

## Install the skills in the harness

pstack is packaged as a Cursor plugin, but its `skills/` tree is portable Agent Skills. Copy it into whatever skills directory your harness reads:

```bash
git clone --depth 1 https://github.com/cursor/plugins /tmp/cursor-plugins
cp -R /tmp/cursor-plugins/pstack/skills/* ~/.codex/skills/      # Codex
cp -R /tmp/cursor-plugins/pstack/skills/* ~/.claude/skills/    # Claude Code
cp -R /tmp/cursor-plugins/pstack/skills/* ~/.pi/agent/skills/  # pi
cp -R /tmp/cursor-plugins/pstack/skills/* .agents/skills/      # project scope
```

That makes `/poteto-mode`, `/architect`, `/correct`, `/tdd`, the playbooks, and the principles discoverable. Discovery is not enforcement. The gates are.

## Gate the order

`ratchet task start --pstack` adds two gates to the contract and the artifact paths to the scope:

| pstack skill | Artifact | Gate |
|---|---|---|
| `/poteto-mode` | `.ratchet/plan.md` | source writes denied until the plan exists |
| `/architect` | `.ratchet/sketch.md` | source writes denied until the sketch exists |

The guard denies a write to `src/**`, `index.html`, or `styles.css` with a message that names the skill and the artifact:

```text
Skill gate: pstack /poteto-mode: write the chosen playbook and its steps to .ratchet/plan.md first [missing .ratchet/plan.md]
```

The model reads the message, writes the artifact, and retries. The order is physical, not a suggestion.

## Map every skill to a check

| pstack skill | What is enforced | How |
|---|---|---|
| `/poteto-mode` | a plan with playbook steps exists before code | gate + plan artifact check |
| `/architect` | types, signatures, and module shape exist before code | gate + sketch artifact check |
| `/correct` | every rule has an enforcer and a proof | `ratchet audit` on `rules.tsv` |
| `/create-verification-skill` | a project-local verify skill and command exist | arch check + contract `--verify` |
| `/tdd` | a test changes with the source | diff check (planned) |
| `/unslop`, `/no-comments` | prose quality | advisory; not gated |
| `/arena`, `/interrogate` | alternative designs, adversarial review | advisory; run when the task warrants |

The rule: if a skill's outcome is observable, give it an artifact and a check. If it is taste, leave it to human review and do not pretend a gate covers it.

## Worked example

A pause feature was added to the Flappy test project under `--pstack`. The agent was told to start coding immediately. The trail:

```text
DENY  Skill gate: pstack /poteto-mode: ... .ratchet/plan.md first [missing .ratchet/plan.md]
DENY  .ratchet is outside scope [...]
ALLOW .ratchet/plan.md
DENY  Skill gate: pstack /architect: ... .ratchet/sketch.md first [missing .ratchet/sketch.md]
ALLOW .ratchet/sketch.md
ALLOW src/game.mjs, index.html
```

The agent produced a plan naming the playbook and a sketch naming the functions before it wrote code. The feature then passed lint, tests, architecture, and tamper checks, and was verified in a real browser.

## Limits

- Gates enforce artifacts, not quality. A model can write a thin plan. The checks verify structure and behavior; a human still reviews intent.
- The artifact paths are in the contract scope on purpose. Everything else under `.ratchet/` stays denied.
- A skill with no observable outcome cannot be gated. Do not invent a check for taste; route it to human review.
