# Adopt Ratchet in three levels

The workflow is default when the environment enforces it, not when the prompt recites it. Install it at three levels.

## Level 1: make the skill discoverable everywhere (once per machine)

```bash
cd ~/ratchet
node bin/ratchet.mjs install
```

This links `skills/ratchet-mode` into:

- `~/.agents/skills/` (the cross-harness location)
- `~/.pi/agent/skills/`
- `~/.claude/skills/`

The skill is now visible to pi, Claude Code, Codex, Cursor, OpenCode, and anything else that implements Agent Skills.

## Level 2: make the repo enforce it (once per repo)

```bash
cd <repo>
node ~/ratchet/bin/ratchet.mjs init
node ~/ratchet/bin/ratchet.mjs sync --install
```

`init` writes `.ratchet/config.json` and `.ratchet/rules.tsv`. `sync --install` does three things:

1. Writes the managed block into `AGENTS.md` so every session sees the loop.
2. Installs `.opencode/plugin/ratchet.js` so OpenCode/T3 Code blocks out-of-scope built-in tool calls.
3. Installs `.git/hooks/pre-commit` so a failing check stops the commit locally.

For pi, copy `adapters/pi/ratchet.ts` into the project extension directory or `~/.pi/agent/extensions/`.
For Claude Code, merge `adapters/claude/settings.example.json` into `.claude/settings.json`.
For Cursor, use the same `PreToolUse` hook shape and verify the current hook config.

## Level 3: make CI the authority (once per repo, server-side)

Add one job:

```yaml
- run: node bin/ratchet.mjs check
```

Make it a required check in branch protection. This is the layer the model cannot edit, skip with `--no-verify`, or talk around. The in-loop adapter is for speed; CI is for truth.

## The 10-minute pilot

1. Pick one small task in one repo.
2. `ratchet task start --role coder --goal "<task>" --scope "<the one directory you will touch>"`
3. Ask the agent to do the task.
4. Watch for one blocked write. That proves the contract is live.
5. Run `ratchet check` and `ratchet done`.
6. Add one row to `.ratchet/rules.tsv` for a mistake the agent made, with the check that now catches it.

If step 4 never happens, the scope is too wide or the adapter is not installed. Narrow the scope before adding more rules.
