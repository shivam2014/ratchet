#!/bin/sh
# Render every Mermaid source and refresh the manifest.
# Requires bun (bunx) and Chrome; the first run downloads mermaid-cli.
set -eu
cd "$(dirname "$0")/.."

if ! command -v bunx >/dev/null 2>&1; then
  echo "bunx is required. Install bun, or run each file with mmdc directly." >&2
  exit 1
fi

for source in docs/diagrams/*.mmd; do
  echo "render $source"
  bunx --bun @mermaid-js/mermaid-cli -i "$source" -o "${source%.mmd}.svg" -t dark -b transparent
done

node scripts/build-diagram-gallery.mjs
node scripts/check-diagrams.mjs --update
