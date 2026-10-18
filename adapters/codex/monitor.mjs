#!/usr/bin/env node
/**
 * Codex session monitor. Prints Codex's file changes and messages, then the
 * Ratchet allow/deny trail for the active contract.
 *
 *   node adapters/codex/monitor.mjs codex.jsonl /path/to/repo
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const jsonlPath = process.argv[2];
const repo = path.resolve(process.argv[3] || process.cwd());
if (!jsonlPath) {
  console.error("usage: node monitor.mjs <codex.jsonl> [repo]");
  process.exit(1);
}

const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
console.log("== codex ==");
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type === "item.completed" && event.item?.type === "file_change") {
    const paths = (event.item.changes ?? []).map((c) => c.path).join(", ");
    console.log(`file_change ${event.item.status}: ${paths}`);
  }
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    console.log(`agent: ${String(event.item.text).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  if (event.type === "turn.completed") {
    const usage = event.usage ?? {};
    console.log(`turn: ${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out`);
  }
}

console.log("\n== ratchet ==");
const bin = path.join(import.meta.dirname, "..", "..", "bin", "ratchet.mjs");
const result = spawnSync(process.execPath, [bin, "report"], { cwd: repo, encoding: "utf8" });
process.stdout.write(result.stdout || "");
if (result.status !== 0) process.stderr.write(result.stderr || "");
