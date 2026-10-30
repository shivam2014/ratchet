# Diagrams

Pictures of how ratchet works, kept as sources so they cannot quietly go stale.

| File | Audience | Answers |
|---|---|---|
| `lifecycle.mmd` | everyone | the main path: contract, checks, done, abandon, stranded |
| `lifecycle-exits.mmd` | everyone | refused, failing, check surface changed, outside scope |
| `architecture-today.mmd` | lead / worker | why two threads in one checkout share a contract |
| `architecture-target.mmd` | lead / worker | one worktree per thread, one contract each |
| `pyramid.mmd` | CEO | what is in place, partial, or missing in the four layers |
| `hierarchy.mmd` | CEO | who talks to whom |
| `roadmap.mmd` | CEO | now / next / later, without dates |

## Rules

- `.mmd` is the source of truth. Do not edit the `.svg` by hand.
- Every source carries `last_verified` and `review_due` comments. Review quarterly.
- `manifest.json` binds each source hash to its svg hash. The check fails when one changes without the other.
- A diagram that disagrees with the code is wrong. Regenerate or delete it.

## Render

```bash
sh scripts/render-diagrams.sh
```

Requires `bunx` and Chrome. The first run downloads `@mermaid-js/mermaid-cli`. If Chrome is not found, set `PUPPETEER_EXECUTABLE_PATH`.

## Verify

```bash
node scripts/check-diagrams.mjs
```

CI runs the same command. `npm test` also includes it.
