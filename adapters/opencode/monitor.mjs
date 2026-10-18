#!/usr/bin/env node
/**
 * OpenCode session monitor. Reads an `opencode run --format json` capture and
 * prints tool calls plus the Ratchet trail.
 *
 *   node adapters/opencode/monitor.mjs opencode.jsonl /path/to/repo
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const jsonlPath = process.argv[2];
const repo = path.resolve(process.argv[3] || process.cwd());
if (!jsonlPath) {
  console.error("usage: node monitor.mjs <opencode.jsonl> [repo]");
  process.exit(1);
}

const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
console.log("== opencode ==");
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type === "tool_use" && event.part) {
    const part = event.part;
    const input = part.state?.input ?? {};
    const output = String(part.state?.output ?? "").replace(/\s+/g, " ").slice(0, 200);
    console.log(`${part.state?.status ?? "?"} ${part.tool} ${JSON.stringify(input).slice(0, 160)} -> ${output}`);
  }
  if (event.type === "text" && String(event.text || "").trim()) {
    console.log(`assistant: ${String(event.text).replace(/\s+/g, " ").slice(0, 240)}`);
  }
  if (event.type === "error") {
    console.log(`error: ${JSON.stringify(event).slice(0, 240)}`);
  }
}

console.log("\n== ratchet ==");
const bin = path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");
const result = spawnSync(process.execPath, [bin, "report"], { cwd: repo, encoding: "utf8" });
process.stdout.write(result.stdout || "");
if (result.status !== 0) process.stderr.write(result.stderr || "");
