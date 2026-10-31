import test from "node:test";
import assert from "node:assert/strict";
import { APPROVABLE_RULES, classifyBash } from "../lib/classify.mjs";
import { classifyWindows, isWindowsAbsolutePath } from "../lib/classify-windows.mjs";

const win = (command) => classifyBash(command, "win32");

test("windows: cmd /c copy names the destination outside the repo", () => {
  const r = classifyBash('cmd /c "copy a.txt C:\\outside\\b.txt"');
  assert.equal(r.write, true);
  assert.equal(r.hardDeny, false);
  assert.deepEqual(r.paths, ["C:\\outside\\b.txt"]);
});

test("windows: powerShell Set-Content names the file it writes", () => {
  const r = classifyBash('powershell -Command "Set-Content C:\\outside\\x.txt hi"');
  assert.equal(r.write, true);
  assert.equal(r.hardDeny, false);
  assert.deepEqual(r.paths, ["C:\\outside\\x.txt"]);
});

test("windows: Remove-Item -Recurse -Force on a drive root is a hard deny", () => {
  for (const command of [
    "Remove-Item -Recurse -Force C:\\",
    'powershell -Command "Remove-Item -Recurse -Force C:\\"',
    "Remove-Item -Recurse -Force C:\\*",
  ]) {
    const r = classifyBash(command);
    assert.equal(r.write, true, command);
    assert.equal(r.hardDeny, true, command);
    assert.equal(r.hardRule, "windows-root-delete", command);
    assert.match(r.reason, /recursive delete/, command);
  }
});

test("windows: format C: is a hard deny", () => {
  for (const command of ["format C:", "format D: /q", "format.com C:"]) {
    const r = classifyBash(command);
    assert.equal(r.hardDeny, true, command);
    assert.equal(r.hardRule, "windows-format", command);
  }
});

test("windows: cmd /c with a read stays a read", () => {
  for (const command of ['cmd /c "echo hi"', "cmd.exe /c echo hi", 'CMD /C "dir"']) {
    const r = classifyBash(command);
    assert.equal(r.write, false, command);
    assert.deepEqual(r.paths, [], command);
  }
});

test("windows: -EncodedCommand fails closed as inline", () => {
  for (const flag of ["-EncodedCommand", "-enc", "-ec", "-e"]) {
    const r = classifyBash(`powershell ${flag} SQBFAFgA`);
    assert.equal(r.write, true, flag);
    assert.equal(r.inline, true, flag);
    assert.match(r.notes.join(";"), /EncodedCommand/, flag);
  }
});

test("windows: POSIX classification is unchanged", () => {
  const cases = [
    ["cat src/a.ts | grep foo", false, false, []],
    ["grep -r foo src", false, false, []],
    ["git diff HEAD~1", false, false, []],
    ["echo hi > src/a.ts", true, false, ["src/a.ts"]],
    ["rm -f src/a.ts", true, false, ["src/a.ts"]],
    ["cp src/a.ts src/b.ts", true, false, ["src/b.ts"]],
    ["git add src/a.ts", true, false, ["src/a.ts"]],
    ["sed -i 's/a/b/' src/a.ts", true, false, ["src/a.ts"]],
    ["node -e \"require('fs').writeFileSync('x','y')\"", true, true, []],
    ["bash -c 'echo x > lib/a.ts'", true, false, ["lib/a.ts"]],
  ];
  for (const [command, write, inline, paths] of cases) {
    const r = classifyBash(command, "darwin");
    assert.equal(r.write, write, command);
    assert.equal(r.inline, inline, command);
    assert.deepEqual(r.paths, paths, command);
    assert.equal(r.hardDeny, false, command);
  }

  const rmRoot = classifyBash("rm -rf /", "darwin");
  assert.equal(rmRoot.hardDeny, true);
  assert.equal(rmRoot.hardRule, "rm-root");
  const forcePush = classifyBash("git push --force origin main", "darwin");
  assert.equal(forcePush.hardDeny, true);
  assert.equal(forcePush.hardRule, "force-push");
});

test("windows: platform can be passed as a string or an options object", () => {
  const string = classifyBash("del build\\out.txt", "win32");
  const object = classifyBash("del build\\out.txt", { platform: "win32" });
  assert.equal(string.write, true);
  assert.deepEqual(string.paths, ["build\\out.txt"]);
  assert.deepEqual(object, string);
});

test("windows: bare cmd verbs are reads on POSIX and writes on win32", () => {
  for (const command of ["del build\\out.txt", "copy a.txt build\\b.txt", "rd build", "ren a.txt b.txt"]) {
    assert.equal(classifyBash(command, "darwin").write, false, command);
    assert.equal(win(command).write, true, command);
  }
});

test("windows: cmd wrappers are recognised with or without .exe and in any case", () => {
  for (const command of [
    "cmd.exe /c copy a.txt C:\\outside\\b.txt",
    "CMD /C copy a.txt C:\\outside\\b.txt",
    "cmd /d /s /c copy a.txt C:\\outside\\b.txt",
    "C:\\Windows\\System32\\cmd.exe /c copy a.txt C:\\outside\\b.txt",
  ]) {
    const r = classifyBash(command);
    assert.equal(r.write, true, command);
    assert.deepEqual(r.paths, ["C:\\outside\\b.txt"], command);
  }

  const relative = classifyBash('cmd /c "del build\\out.txt"');
  assert.equal(relative.write, true);
  assert.deepEqual(relative.paths, ["build\\out.txt"]);
});

test("windows: PowerShell wrappers are recognised with or without .exe", () => {
  for (const command of [
    "powershell.exe -Command \"Add-Content C:\\outside\\x.txt hi\"",
    "pwsh -Command \"Out-File C:\\outside\\x.txt\"",
    "pwsh.exe -c \"Clear-Content C:\\outside\\x.txt\"",
  ]) {
    const r = classifyBash(command);
    assert.equal(r.write, true, command);
    assert.deepEqual(r.paths, ["C:\\outside\\x.txt"], command);
  }

  const relative = classifyBash('powershell -Command "Remove-Item -Recurse build\\out"');
  assert.equal(relative.write, true);
  assert.deepEqual(relative.paths, ["build\\out"]);
});

test("windows: PowerShell remove aliases name their targets", () => {
  for (const verb of ["Remove-Item", "ri", "rm", "del", "erase", "rd", "rmdir"]) {
    const r = win(`${verb} C:\\outside\\a.txt`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, ["C:\\outside\\a.txt"], verb);
  }
});

test("windows: PowerShell content verbs name their file", () => {
  for (const [verb, args] of [
    ["Set-Content", "C:\\outside\\x.txt hi"],
    ["sc", "C:\\outside\\x.txt hi"],
    ["Add-Content", "C:\\outside\\x.txt hi"],
    ["ac", "C:\\outside\\x.txt hi"],
    ["Out-File", "C:\\outside\\x.txt"],
    ["Clear-Content", "C:\\outside\\x.txt"],
    ["clc", "C:\\outside\\x.txt"],
  ]) {
    const r = win(`${verb} ${args}`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, ["C:\\outside\\x.txt"], verb);
  }
});

test("windows: PowerShell item and property verbs name their file", () => {
  for (const [verb, args, expected] of [
    ["New-Item", "C:\\outside\\new.txt", "C:\\outside\\new.txt"],
    ["ni", "C:\\outside\\new.txt", "C:\\outside\\new.txt"],
    ["Set-ItemProperty", "C:\\outside\\a.txt prop val", "C:\\outside\\a.txt"],
    ["sp", "C:\\outside\\a.txt prop val", "C:\\outside\\a.txt"],
    ["Remove-ItemProperty", "C:\\outside\\a.txt prop", "C:\\outside\\a.txt"],
    ["rp", "C:\\outside\\a.txt prop", "C:\\outside\\a.txt"],
    ["New-ItemProperty", "C:\\outside\\a.txt prop val", "C:\\outside\\a.txt"],
  ]) {
    const r = win(`${verb} ${args}`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, [expected], verb);
  }
});

test("windows: PowerShell copy and move check the destination", () => {
  for (const verb of ["Copy-Item", "cpi", "cp", "copy", "Move-Item", "mi", "move"]) {
    const r = win(`${verb} a.txt C:\\outside\\b.txt`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, ["C:\\outside\\b.txt"], verb);
  }
  const flagged = win("Copy-Item -Destination C:\\outside\\b.txt -Path a.txt");
  assert.equal(flagged.write, true);
  assert.deepEqual(flagged.paths, ["C:\\outside\\b.txt"]);
});

test("windows: PowerShell rename resolves the new name against the source parent", () => {
  for (const verb of ["Rename-Item", "ren", "rename"]) {
    const r = win(`${verb} C:\\outside\\a.txt b.txt`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, ["C:\\outside\\a.txt", "C:\\outside\\b.txt"], verb);
  }
  const inRepo = win("Rename-Item src\\a.txt b.txt");
  assert.deepEqual(inRepo.paths, ["src\\a.txt", "src\\b.txt"]);
});

test("windows: cmd delete and directory verbs name their targets", () => {
  for (const [verb, target] of [
    ["del", "C:\\outside\\a.txt"],
    ["erase", "C:\\outside\\a.txt"],
    ["rmdir", "C:\\outside\\dir"],
    ["rd", "C:\\outside\\dir"],
    ["mkdir", "C:\\outside\\dir"],
    ["md", "C:\\outside\\dir"],
  ]) {
    const r = win(`${verb} ${target}`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, [target], verb);
  }
});

test("windows: cmd copy, move, replace, rename and robocopy name the destination", () => {
  for (const [verb, args, expected] of [
    ["copy", "a.txt C:\\outside\\b.txt", "C:\\outside\\b.txt"],
    ["move", "a.txt C:\\outside\\b.txt", "C:\\outside\\b.txt"],
    ["replace", "a.txt C:\\outside\\b.txt", "C:\\outside\\b.txt"],
    ["robocopy", "src C:\\outside\\dst /mir", "C:\\outside\\dst"],
    ["xcopy", "src C:\\outside\\dst /e /i", "C:\\outside\\dst"],
  ]) {
    const r = win(`${verb} ${args}`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, [expected], verb);
  }

  const rename = win("ren C:\\outside\\a.txt b.txt");
  assert.deepEqual(rename.paths, ["C:\\outside\\a.txt", "C:\\outside\\b.txt"]);
});

test("windows: cmd attribute and ACL verbs name their target", () => {
  for (const [verb, args] of [
    ["attrib", "+r C:\\outside\\a.txt"],
    ["icacls", "C:\\outside\\a.txt /grant user:F"],
    ["takeown", "/f C:\\outside\\a.txt"],
  ]) {
    const r = win(`${verb} ${args}`);
    assert.equal(r.write, true, verb);
    assert.deepEqual(r.paths, ["C:\\outside\\a.txt"], verb);
  }
});

test("windows: flags are not treated as paths", () => {
  const r = win("del /s /q build\\out.txt");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["build\\out.txt"]);

  const copy = win("copy /b a.txt build\\b.txt");
  assert.deepEqual(copy.paths, ["build\\b.txt"]);

  const robocopy = win("robocopy src dst /mir /purge");
  assert.deepEqual(robocopy.paths, ["dst"]);
});

test("windows: drive, UNC and forward-slash paths are parsed lexically", () => {
  for (const target of ["C:\\outside\\b.txt", "C:/outside/b.txt", "\\\\server\\share\\b.txt"]) {
    const r = classifyBash(`copy a.txt ${target}`);
    assert.equal(r.write, true, target);
    assert.deepEqual(r.paths, [target], target);
  }
  assert.equal(isWindowsAbsolutePath("C:\\outside\\b.txt"), true);
  assert.equal(isWindowsAbsolutePath("C:/outside/b.txt"), true);
  assert.equal(isWindowsAbsolutePath("\\\\server\\share\\b.txt"), true);
  assert.equal(isWindowsAbsolutePath("src/b.txt"), false);
  assert.equal(isWindowsAbsolutePath("/tmp/x"), false);
});

test("windows: relative paths are reported for win32", () => {
  const r = win("del build\\out.txt");
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["build\\out.txt"]);
});

test("windows: hard rules are not approvable", () => {
  assert.deepEqual([...APPROVABLE_RULES].sort(), ["force-push", "git-clean", "hard-reset"]);
});

test("windows: destructive system commands are hard denies", () => {
  for (const [command, rule] of [
    ["diskpart", "windows-diskpart"],
    ["bcdedit /set {default} safeboot minimal", "windows-boot-config"],
    ["reg delete HKLM\\Software\\X /f", "windows-reg-delete"],
    ["del /s /q C:\\", "windows-root-delete"],
    ["rd /s /q C:\\", "windows-root-delete"],
    ["shutdown /r /t 0", "windows-shutdown"],
    ["shutdown /s", "windows-shutdown"],
    ["shutdown -r", "windows-shutdown"],
  ]) {
    const r = classifyBash(command);
    assert.equal(r.hardDeny, true, command);
    assert.equal(r.hardRule, rule, command);
  }
});

test("windows: non-root recursive deletes are writes, not hard denies", () => {
  for (const command of ["del /s /q C:\\Windows\\Temp", "rd /s /q C:\\Windows\\Temp", "Remove-Item -Recurse -Force C:\\Windows\\Temp"]) {
    const r = classifyBash(command);
    assert.equal(r.hardDeny, false, command);
    assert.equal(r.write, true, command);
  }
});

test("windows: PowerShell opaque payloads fail closed", () => {
  for (const command of [
    'powershell -Command "Invoke-Expression $x"',
    'powershell -Command "iex $x"',
    'powershell -Command "Remove-Item $env:TEMP\\x"',
    'powershell -Command "Set-Content $(Get-Item x) hi"',
    "powershell -File tools\\clean.ps1",
    "cmd /c \"del %TEMP%\\x\"",
  ]) {
    const r = classifyBash(command);
    assert.equal(r.write, true, command);
    assert.equal(r.inline, true, command);
  }
});

test("windows: Start-Process fails closed only for write redirections", () => {
  const launch = classifyBash("Start-Process notepad");
  assert.equal(launch.write, false);
  assert.deepEqual(launch.paths, []);

  const redirect = classifyBash("Start-Process foo -RedirectStandardOutput C:\\outside\\log.txt");
  assert.equal(redirect.write, true);
  assert.deepEqual(redirect.paths, ["C:\\outside\\log.txt"]);

  const stderr = classifyBash("Start-Process foo -RedirectStandardError C:\\outside\\err.txt");
  assert.equal(stderr.write, true);
  assert.deepEqual(stderr.paths, ["C:\\outside\\err.txt"]);
});

test("windows: nested wrappers are classified recursively", () => {
  const nested = classifyBash('cmd /c powershell -Command "Remove-Item C:\\outside\\x.txt"');
  assert.equal(nested.write, true);
  assert.deepEqual(nested.paths, ["C:\\outside\\x.txt"]);

  const forcePush = classifyBash('cmd /c "git push --force"');
  assert.equal(forcePush.hardDeny, true);
  assert.equal(forcePush.hardRule, "force-push");
});

test("windows: sc is service control in cmd and Set-Content in PowerShell context", () => {
  const query = win("sc query");
  assert.equal(query.write, false);
  assert.deepEqual(query.paths, []);

  const write = win("sc C:\\outside\\x.txt hi");
  assert.equal(write.write, true);
  assert.deepEqual(write.paths, ["C:\\outside\\x.txt"]);
});

test("windows: hard rules ignore heredoc bodies and quoted data", () => {
  const heredoc = classifyBash("cat > /tmp/note.txt <<'EOF'\nformat C:\ndel /s /q C:\\\nEOF");
  assert.equal(heredoc.hardDeny, false);
  assert.deepEqual(heredoc.paths, ["/tmp/note.txt"]);

  const patch = classifyBash("apply_patch <<'END PATCH'\n*** Add File: src/note.txt\n+diskpart\n+bcdedit\nEND PATCH");
  assert.equal(patch.hardDeny, false);
  assert.deepEqual(patch.paths, ["src/note.txt"]);

  const echo = classifyBash('echo "format C:" && echo "del /s /q C:\\\\"');
  assert.equal(echo.hardDeny, false);
  assert.equal(echo.write, false);
});

test("windows: a comment containing << does not hide the next command", () => {
  const r = classifyBash('# note <<EOF\ncmd /c "del C:\\outside\\x.txt"');
  assert.equal(r.write, true);
  assert.deepEqual(r.paths, ["C:\\outside\\x.txt"]);
});

test("windows: dynamic command names fail closed", () => {
  for (const command of ["powershell -Command \"& $exe args\"", "cmd /c \"%COMSPEC% /c del x\"", "powershell -Command \"& (Get-Command x) args\""]) {
    const r = classifyBash(command);
    assert.equal(r.write, true, command);
    assert.equal(r.inline, true, command);
  }
});

test("windows: cd is tracked for later relative operands", () => {
  const direct = win("cd C:\\outside && del x");
  assert.equal(direct.write, true);
  assert.deepEqual(direct.paths, ["C:\\outside\\x"]);

  const driveChange = win("cd /d C:\\outside && copy a.txt b.txt");
  assert.deepEqual(driveChange.paths, ["C:\\outside\\b.txt"]);

  const nested = classifyBash('cd C:\\outside && cmd /c "del x"');
  assert.equal(nested.write, true);
  assert.deepEqual(nested.paths, ["C:\\outside\\x"]);

  const parent = win("cd C:\\outside\\sub && cd .. && del x");
  assert.deepEqual(parent.paths, ["C:\\outside\\x"]);

  const unresolved = win("cd %TEMP% && del x");
  assert.equal(unresolved.write, true);
  assert.equal(unresolved.inline, true);

  const posix = classifyBash("cd src && del x", "darwin");
  assert.equal(posix.write, false);
});

test("windows: classifyWindows exposes the raw result", () => {
  const r = classifyWindows('cmd /c "copy a.txt C:\\outside\\b.txt"', { platform: "darwin" });
  assert.equal(r.write, true);
  assert.equal(r.detected, true);
  assert.deepEqual(r.paths, ["C:\\outside\\b.txt"]);

  const read = classifyWindows("cat src/a.ts", { platform: "darwin" });
  assert.equal(read.write, false);
  assert.equal(read.detected, false);
});
