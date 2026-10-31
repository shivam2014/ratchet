import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectSandbox, toWslPath, wrapCommand } from "../lib/sandbox.mjs";

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-wsl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("sandbox: Windows reports wsl-bwrap when WSL2 has bubblewrap", () => {
  const result = detectSandbox({
    platform: "win32",
    wsl: { bin: "C:\\Windows\\System32\\wsl.exe", bwrap: "/usr/bin/bwrap" },
  });
  assert.equal(result.backend, "wsl-bwrap");
  assert.equal(result.bin, "C:\\Windows\\System32\\wsl.exe");
  assert.equal(result.bwrap, "/usr/bin/bwrap");
});

test("sandbox: Windows without wsl.exe fails closed with a WSL2 reason", () => {
  const result = detectSandbox({ platform: "win32", which: () => null });
  assert.equal(result.backend, null);
  assert.match(result.reason, /WSL2/);
});

test("sandbox: Windows with wsl.exe but no bwrap fails closed", () => {
  const result = detectSandbox({
    platform: "win32",
    wsl: { bin: "wsl.exe" },
    wslProbe: () => null,
  });
  assert.equal(result.backend, null);
  assert.match(result.reason, /bwrap/);
});

test("sandbox: Windows drives map to /mnt/<drive>", () => {
  assert.equal(toWslPath("C:\\repo\\src"), "/mnt/c/repo/src");
  assert.equal(toWslPath("D:/work/repo"), "/mnt/d/work/repo");
  assert.equal(toWslPath("/tmp/keep"), "/tmp/keep");
  assert.equal(toWslPath("C:\\repo", { wslPath: () => "/custom" }), "/custom");
});

test("sandbox: wsl-bwrap wraps bwrap inside wsl.exe", (t) => {
  const root = repo(t);
  const wrapped = wrapCommand("echo ok", {
    platform: "win32",
    root,
    contract: { scope: ["**"] },
    backend: "wsl-bwrap",
    bin: "wsl.exe",
    bwrap: "/usr/bin/bwrap",
  });

  assert.equal(wrapped.backend, "wsl-bwrap");
  assert.equal(wrapped.enforced, true);
  assert.equal(wrapped.argv[0], "wsl.exe");
  assert.deepEqual(wrapped.argv.slice(1, 3), ["--exec", "/usr/bin/bwrap"]);
  assert.ok(wrapped.argv.includes("/bin/sh"));
  assert.ok(wrapped.argv.includes("--chdir"));
  assert.match(wrapped.command, /wsl\.exe/);
  assert.match(wrapped.command, /--exec/);
});

test("sandbox: a POSIX backend on Windows is refused", (t) => {
  const root = repo(t);
  assert.throws(
    () =>
      wrapCommand("echo ok", {
        platform: "win32",
        root,
        contract: { scope: ["**"] },
        backend: "seatbelt",
        bin: "/usr/bin/sandbox-exec",
      }),
    /unavailable on Windows/,
  );
});

test("sandbox: Git Bash drive paths map to /mnt/<drive> on Windows", () => {
  assert.equal(toWslPath("/c/repo/src", { platform: "win32" }), "/mnt/c/repo/src");
  assert.equal(toWslPath("/c/repo/src", { platform: "linux" }), "/c/repo/src");
});

test("sandbox: the WSL command carries the payload as base64", (t) => {
  const root = repo(t);
  const wrapped = wrapCommand("echo ok", {
    platform: "win32",
    root,
    contract: { scope: ["**"] },
    backend: "wsl-bwrap",
    bin: "wsl.exe",
    bwrap: "/usr/bin/bwrap",
  });
  assert.match(wrapped.command, /base64 -d/);
  assert.doesNotMatch(wrapped.command, /echo ok/);
});
