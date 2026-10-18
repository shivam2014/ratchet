#!/usr/bin/env node
/**
 * pi session monitor. Reads a `pi --mode json` capture and prints tool
 * executions plus the Ratchet trail.
 *
 *   node adapters/pi/monitor.mjs pi.jsonl /path/to/repo
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const jsonlPath = process.argv[2];
const repo = path.resolve(process.argv[3] || process.cwd());
if (!jsonlPath) {
  console.error("usage: node monitor.mjs <pi.jsonl> [repo]");
  process.exit(1);
}

const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
console.log("== pi ==");
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type === "tool_execution_start") {
    console.log(`tool ${event.toolName} ${JSON.stringify(event.args).slice(0, 180)}`);
  }
  if (event.type === "tool_execution_end") {
    const text = (event.result?.content ?? [])
      .map((c) => c.text)
      .filter(Boolean)
      .join(" ");
    console.log(`${event.isError ? "error" : "ok"} ${event.toolName} ${text.replace(/\s+/g, " ").slice(0, 220)}`);
  }
}

console.log("\n== ratchet ==");
const bin = path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");
const result = spawnSync(process.execPath, [bin, "report"], { cwd: repo, encoding: "utf8" });
process.stdout.write(result.stdout || "");
if (result.status !== 0) process.stderr.write(result.stderr || "");
