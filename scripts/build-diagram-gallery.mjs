#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import path from "node:path";

const dir = path.join(path.resolve(import.meta.dirname, ".."), "docs", "diagrams");
const sections = [
  ["lifecycle", "start · checks · done · abandon · stranded", "The main path: task start, checks pass, done. Plus abandon and stranded."],
  ["lifecycle-exits", "refused · failing · surface changed · outside scope", "The exits from the live state, and how they return."],
  ["architecture-today", "two leads in one checkout share one contract", "Why two threads in one checkout cannot both be the lead."],
  ["architecture-target", "one worktree per lead thread, one contract each", "One thread, one lead, one contract."],
  ["pyramid", "code · static analysis · prose · human review", "What is in place, partial, or missing."],
  ["hierarchy", "CEO · lead thread · workers", "Who you talk to, and what wraps all of them."],
  ["roadmap", "now · next · later", "Forecast, not a commitment. No dates."],
];

const cards = sections
  .map(([name, note, caption]) => {
    const file = path.join(dir, `${name}.svg`);
    if (!fs.existsSync(file)) throw new Error(`${file} is missing; run scripts/render-diagrams.sh`);
    const data = fs.readFileSync(file).toString("base64");
    return `  <section>
    <div class="k">${name}</div>
    <img src="data:image/svg+xml;base64,${data}" alt="${caption}">
    <div class="note">${note}</div>
  </section>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ratchet diagrams</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #0a0b0d; color: #f4f1ea; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -.02em; }
  p { color: #9aa0a8; margin: 0 0 24px; }
  section { margin: 0 0 28px; }
  h2, .k { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #7be0a3; margin: 0 0 8px; }
  img { display: block; width: 100%; height: auto; background: #101216; border: 1px solid #24272d; border-radius: 10px; }
  .note { color: #6f7680; font-size: 12px; margin-top: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Ratchet diagrams</h1>
  <p>Sources are <code>.mmd</code>. This file is generated with the SVGs inlined, so it opens anywhere; do not edit it by hand.</p>
${cards}
</div>
</body>
</html>
`;

fs.writeFileSync(path.join(dir, "index.html"), html);
console.log(`gallery: ${sections.length} diagram(s), self-contained`);
