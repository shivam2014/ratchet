# Adopt Ratchet in three levels

The workflow is default when the environment enforces it, not when the prompt recites it. Install it at three levels.

## Level 1: install the harness adapters (once per machine)

```bash
cd ~/ratchet
node bin/ratchet.mjs install --user
```

With no `--harness`, Ratchet detects what is on the machine and prompts. To be explicit:

```bash
node bin/ratchet.mjs install --user --harness pi,claude,opencode,t3,codex --yes
```

| Harness | Global paths written |
|---|---|
| pi | `~/.pi/agent/extensions/ratchet.ts`, `~/.pi/agent/skills/ratchet-mode` |
| Claude Code | `~/.claude/settings.json` hook, `~/.claude/skills/ratchet-mode` |
| OpenCode | `~/.config/opencode/plugins/ratchet.js`, `~/.agents/skills/ratchet-mode` |
| T3 Code | the same OpenCode plugin and skill |
| Codex | `~/.agents/skills/ratchet-mode` |

`ratchet status` lists what is installed. `ratchet uninstall --harness ...` removes only those paths.

## Level 2: make the repo enforce it (once per repo)

```bash
cd <repo>
node ~/ratchet/bin/ratchet.mjs init
node ~/ratchet/bin/ratchet.mjs install --project --harness pi,claude,opencode,t3 --yes
```

`init` writes `.ratchet/config.json` and `.ratchet/rules.tsv`. `install --project` does four things:

1. Writes the project adapter and skill for each selected harness.
2. Writes the managed block into `AGENTS.md` so every session sees the loop.
3. Installs `.git/hooks/pre-commit` so a failing check stops the commit locally.
4. Records every path in `.ratchet/install.json` so uninstall is exact.

Codex has no pre-tool hook. Its install is the skill only. Use the sandbox and CI as the boundary.

For Cursor, use the same `PreToolUse` shape as Claude Code and verify the current hook config.

## Level 3: make CI the authority (once per repo, server-side)

Add one job:

```yaml
- run: node bin/ratchet.mjs check
```

Make it a required check in branch protection. This is the layer the model cannot edit, skip with `--no-verify`, or talk around. The in-loop adapter is for speed; CI is for truth.

## Kill switch

When the guard produces a false positive:

```bash
ratchet disable --reason "false positive on generated files"
ratchet enable
```

`disable` writes `.ratchet/disabled.json`. The guard allows tool calls and records that it was disabled; `check` and `done` still run. `status` and `doctor` report the reason. Fix the guard, then re-enable; do not leave it off silently.

## The 10-minute pilot

1. Pick one small task in one repo.
2. `ratchet task start --role coder --goal "<task>" --scope "<the one directory you will touch>"`
3. Ask the agent to do the task.
4. Watch for one blocked write. That proves the contract is live.
5. Run `ratchet check` and `ratchet done`.
6. Add one row to `.ratchet/rules.tsv` for a mistake the agent made, with the check that now catches it.

If step 4 never happens, the scope is too wide or the adapter is not installed. Check with `ratchet status` and `ratchet doctor`, then narrow the scope before adding more rules.
