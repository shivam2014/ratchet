#!/usr/bin/env node
// @ts-check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "docs", "diagrams");
const manifestFile = path.join(dir, "manifest.json");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The diagrams are sources (.mmd) plus rendered artifacts (.svg). The manifest
 * binds each source hash to its svg hash. Change one without the other and the
 * check fails, so a stale picture cannot pass review as current.
 */
export function checkDiagrams({ update = false } = {}) {
  if (!fs.existsSync(dir)) return { errors: [`${dir} does not exist`], updated: false, count: 0 };
  const sources = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mmd"))
    .sort();
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { version: 1, diagrams: {} };
  const next = { version: 1, diagrams: {} };
  const errors = [];

  for (const source of sources) {
    const name = source.slice(0, -4);
    const svg = `${name}.svg`;
    const sourcePath = path.join(dir, source);
    const svgPath = path.join(dir, svg);
    if (!fs.existsSync(svgPath)) {
      errors.push(`${name}: ${svg} is missing; run scripts/render-diagrams.sh`);
      continue;
    }
    const entry = {
      source,
      svg,
      sourceSha256: sha256(sourcePath),
      svgSha256: sha256(svgPath),
    };
    next.diagrams[name] = entry;
    const recorded = manifest.diagrams?.[name];
    if (!recorded) {
      errors.push(`${name}: not in manifest.json; run scripts/render-diagrams.sh`);
    } else if (recorded.sourceSha256 !== entry.sourceSha256) {
      errors.push(`${name}: source changed; re-render with scripts/render-diagrams.sh`);
    } else if (recorded.svgSha256 !== entry.svgSha256) {
      errors.push(`${name}: svg changed; re-render with scripts/render-diagrams.sh`);
    }
  }

  for (const name of Object.keys(manifest.diagrams ?? {})) {
    if (!next.diagrams[name]) errors.push(`${name}: manifest entry has no source`);
  }

  if (update) {
    fs.writeFileSync(manifestFile, `${JSON.stringify(next, null, 2)}\n`);
    return { errors: [], updated: true, count: sources.length };
  }
  return { errors, updated: false, count: sources.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkDiagrams({ update: process.argv.includes("--update") });
  if (result.updated) {
    console.log(`diagram manifest updated: ${result.count} diagram(s)`);
    process.exit(0);
  }
  for (const error of result.errors) console.error(`FAIL ${error}`);
  if (result.errors.length) process.exit(1);
  console.log(`diagrams: ${result.count} source(s), svg and manifest match`);
}
