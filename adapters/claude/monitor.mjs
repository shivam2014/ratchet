#!/usr/bin/env node
/**
 * Claude Code session monitor. Reads a `claude -p --output-format stream-json`
 * capture and prints tool calls, messages, and the Ratchet trail.
 *
 *   node adapters/claude/monitor.mjs claude.jsonl /path/to/repo
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const jsonlPath = process.argv[2];
const repo = path.resolve(process.argv[3] || process.cwd());
if (!jsonlPath) {
  console.error("usage: node monitor.mjs <claude.jsonl> [repo]");
  process.exit(1);
}

const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
console.log("== claude ==");
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") {
        console.log(`tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
      }
      if (block.type === "text" && block.text.trim()) {
        console.log(`assistant: ${block.text.replace(/\s+/g, " ").slice(0, 240)}`);
      }
    }
  }
  if (event.type === "result") {
    console.log(`result: ${String(event.result || "").replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

console.log("\n== ratchet ==");
const bin = path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");
const result = spawnSync(process.execPath, [bin, "report"], { cwd: repo, encoding: "utf8" });
process.stdout.write(result.stdout || "");
if (result.status !== 0) process.stderr.write(result.stderr || "");
