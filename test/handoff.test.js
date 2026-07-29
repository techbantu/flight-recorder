import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  canonicalJson as productionCanonicalJson,
  sha256 as productionSha256,
  writeImmutable,
} from "../src/integrity.js";
import { isValidTask } from "../src/contracts.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initPath = join(repositoryRoot, "bin", "fr-init.js");
const cliPath = join(repositoryRoot, "bin", "fr.js");
const temporaryDirectories = [];

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const normalized = (value) => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalized(value[key])]),
  );
};

const canonicalJson = (value) => JSON.stringify(normalized(value));

const runProcess = (cwd, executable, arguments_, options = {}) =>
  spawnSync(executable, arguments_, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });

const git = (cwd, ...arguments_) => {
  const result = runProcess(cwd, "git", arguments_);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const makeGitWorkspace = async ({ ignored = false } = {}) => {
  const workspace = await mkdtemp(join(tmpdir(), "flight-recorder-handoff-"));
  temporaryDirectories.push(workspace);

  git(workspace, "init", "--quiet");
  git(workspace, "config", "user.email", "flight-recorder@example.invalid");
  git(workspace, "config", "user.name", "Flight Recorder Test");
  await writeFile(join(workspace, "tracked.txt"), "baseline\n", "utf8");
  if (ignored) {
    await writeFile(join(workspace, ".gitignore"), "ignored.txt\n", "utf8");
  }
  git(workspace, "add", ".");
  git(workspace, "commit", "--quiet", "-m", "baseline");

  const initialized = runProcess(workspace, process.execPath, [
    initPath,
    "Verify handoff",
  ]);
  assert.equal(initialized.status, 0, initialized.stderr);

  return {
    workspace,
    recorder: join(workspace, "ops", "verify-handoff"),
    recorderArgument: join("ops", "verify-handoff"),
  };
};

const runCli = (workspace, ...arguments_) =>
  runProcess(workspace, process.execPath, [cliPath, ...arguments_]);

const runObserved = (context, ...command) =>
  runCli(
    context.workspace,
    "run",
    context.recorderArgument,
    "--",
    ...command,
  );

const receiptPaths = async (context) =>
  (await readdir(join(context.recorder, "receipts")))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(context.recorder, "receipts", name));

const seal = async (context) => {
  const result = runCli(
    context.workspace,
    "seal",
    context.recorderArgument,
  );
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/^SEALED (.+)\n$/u);
  assert.ok(match, result.stdout);
  return { result, path: join(context.workspace, match[1]) };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("run witnesses exact argv but stores only output hashes and byte counts", async () => {
  const context = await makeGitWorkspace();
  const stdout = "visible stdout\n";
  const stderr = "private-looking stderr\n";
  const literalArgument = "$(touch should-not-exist)";
  const explicitUrl =
    "https://argument-user:argument-token@example.invalid/repository.git";
  const configuredRemote =
    "https://configured-user:configured-token@example.invalid/repository.git";
  git(context.workspace, "remote", "add", "origin", configuredRemote);
  const script = [
    "process.stdout.write(process.env.TEST_STDOUT);",
    "process.stderr.write(process.env.TEST_STDERR);",
    "if (process.argv[1] !== process.env.EXPECTED_LITERAL) process.exit(9);",
    "if (process.argv[2] !== process.env.EXPECTED_URL) process.exit(10);",
  ].join("");
  const result = runProcess(
    context.workspace,
    process.execPath,
    [
      cliPath,
      "run",
      context.recorderArgument,
      "--",
      process.execPath,
      "-e",
      script,
      literalArgument,
      explicitUrl,
    ],
    {
      env: {
        ...process.env,
        EXPECTED_LITERAL: literalArgument,
        EXPECTED_URL: explicitUrl,
        TEST_STDOUT: stdout,
        TEST_STDERR: stderr,
        FLIGHT_RECORDER_TEST_SECRET: "must-not-enter-the-receipt",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, stdout);
  assert.match(result.stderr, /private-looking stderr/);
  assert.match(result.stderr, /RECORDED .*receipts[/\\]receipt-/);
  await assert.rejects(access(join(context.workspace, "should-not-exist")), {
    code: "ENOENT",
  });

  const [receiptPath] = await receiptPaths(context);
  const receiptText = await readFile(receiptPath, "utf8");
  const receipt = JSON.parse(receiptText);

  assert.equal(receipt.kind, "dev.flight-recorder.command-receipt");
  assert.equal(receipt.observation, "observed-by-flight-recorder");
  assert.deepEqual(receipt.command.argv, [
    process.execPath,
    "-e",
    script,
    literalArgument,
    explicitUrl,
  ]);
  assert.deepEqual(receipt.result.stdout, {
    bytes: Buffer.byteLength(stdout),
    sha256: sha256(stdout),
  });
  assert.deepEqual(receipt.result.stderr, {
    bytes: Buffer.byteLength(stderr),
    sha256: sha256(stderr),
  });
  assert.equal(receipt.result.exitCode, 0);
  assert.equal(receiptText.includes(stdout.trim()), false);
  assert.equal(receiptText.includes(stderr.trim()), false);
  assert.equal(receiptText.includes("must-not-enter-the-receipt"), false);
  assert.equal(receiptText.includes(explicitUrl), true);
  assert.equal(receiptText.includes(configuredRemote), false);
  assert.equal("env" in receipt, false);
});

test("run writes a receipt and preserves a failing child exit status", async () => {
  const context = await makeGitWorkspace();
  const result = runObserved(
    context,
    process.execPath,
    "-e",
    "process.exit(7)",
  );

  assert.equal(result.status, 7);
  const [receiptPath] = await receiptPaths(context);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.result.exitCode, 7);
  assert.equal(receipt.result.timedOut, false);
});

test("run records spawn failure without creating a valid-looking success", async () => {
  const context = await makeGitWorkspace();
  const result = runObserved(
    context,
    "flight-recorder-command-that-does-not-exist",
  );

  assert.equal(result.status, 127);
  const [receiptPath] = await receiptPaths(context);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.notEqual(receipt.result.exitCode, 0);
  assert.equal(receipt.result.spawnErrorCode, "ENOENT");
});

test("run rejects the removed timeout option before spawning a command", async () => {
  const context = await makeGitWorkspace();
  const sentinel = join(context.workspace, "timeout-command-ran");
  const result = runCli(
    context.workspace,
    "run",
    context.recorderArgument,
    "--timeout",
    "50",
    "--",
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[E_OPTION_UNKNOWN\]/u);
  await assert.rejects(access(sentinel), { code: "ENOENT" });
  assert.deepEqual(await receiptPaths(context), []);
});

test("immutable publication removes its temporary file after a pre-link failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "flight-recorder-atomic-"));
  temporaryDirectories.push(workspace);
  const target = join(workspace, "receipt.json");

  await assert.rejects(writeImmutable(target, Symbol("invalid-content")));
  assert.deepEqual(await readdir(workspace), []);
});

test("immutable publication compares existing content as raw bytes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "flight-recorder-bytes-"));
  temporaryDirectories.push(workspace);
  const target = join(workspace, "receipt.json");
  await writeFile(target, Buffer.from([0xff]));

  await assert.rejects(
    writeImmutable(target, "\ufffd"),
    { code: "E_IMMUTABLE_CONFLICT" },
  );
  assert.deepEqual(await readFile(target), Buffer.from([0xff]));
});

test("seal is content-addressed and verify returns VALID for current observed proof", async () => {
  const context = await makeGitWorkspace();
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );

  const first = await seal(context);
  const second = await seal(context);
  assert.equal(second.path, first.path);
  assert.match(first.path, /capsules[/\\]sha256-[a-f0-9]{64}\.json$/u);
  assert.equal((await readdir(join(context.recorder, "capsules"))).length, 1);

  const verified = runCli(
    context.workspace,
    "verify",
    first.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /^VALID\b/u);
});

test("canonical JSON has a reproducible UTF-8 SHA-256 known vector", () => {
  const value = {
    z: [3, { β: "line\n", a: true }],
    a: "π",
  };
  const canonical = '{"a":"π","z":[3,{"a":true,"β":"line\\n"}]}';

  assert.equal(productionCanonicalJson(value), canonical);
  assert.equal(
    Buffer.from(productionCanonicalJson(value), "utf8").toString("hex"),
    Buffer.from(canonical, "utf8").toString("hex"),
  );
  assert.equal(
    productionSha256(productionCanonicalJson(value)),
    "d0f47fc89494118614fb87e455d261df890212a0afdcc4e65c0c124b84828143",
  );
  assert.equal(
    productionCanonicalJson({ 2: "two", 10: "ten", a: "aye" }),
    '{"10":"ten","2":"two","a":"aye"}',
  );
});

test("public v1 schemas are parseable, stable, and share workspace contracts", async () => {
  const handoff = JSON.parse(
    await readFile(join(repositoryRoot, "schema", "handoff-v1.schema.json"), "utf8"),
  );
  const receipt = JSON.parse(
    await readFile(
      join(repositoryRoot, "schema", "command-receipt-v1.schema.json"),
      "utf8",
    ),
  );

  assert.equal(
    handoff.$id,
    "urn:techbantu:flight-recorder:schema:handoff:v1",
  );
  assert.equal(
    receipt.$id,
    "urn:techbantu:flight-recorder:schema:command-receipt:v1",
  );
  for (const definition of [
    "task",
    "relativePath",
    "digest",
    "workspaceFileSummary",
    "workspace",
  ]) {
    assert.deepEqual(receipt.$defs[definition], handoff.$defs[definition]);
  }
  assert.equal(
    handoff.$defs.digest.properties.bytes.maximum,
    Number.MAX_SAFE_INTEGER,
  );
  assert.deepEqual(
    handoff.$defs.workspaceFileSummary.properties.mode.enum,
    ["100644", "100755"],
  );
  const taskPattern = new RegExp(handoff.$defs.task.pattern, "u");
  assert.equal(isValidTask("\u2028A"), true);
  assert.equal(taskPattern.test("\u2028A"), true);
});

test("verify returns UNVERIFIED when a fresh capsule has no successful observed command", async () => {
  const context = await makeGitWorkspace();
  await writeFile(
    join(context.recorder, "receipts", "manual-note.txt"),
    "A person claims the tests passed.\n",
    "utf8",
  );
  const capsule = await seal(context);

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 3, verified.stderr);
  assert.match(verified.stdout, /^UNVERIFIED\b/u);
});

test("verify returns UNVERIFIED when successful evidence predates the sealed workspace", async () => {
  const context = await makeGitWorkspace();
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  await writeFile(join(context.workspace, "tracked.txt"), "changed later\n", "utf8");
  const capsule = await seal(context);

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 3, verified.stderr);
  assert.match(verified.stdout, /^UNVERIFIED\b/u);
});

test("a successful receipt supports only the task it observed", async () => {
  const context = await makeGitWorkspace();
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  const statePath = join(context.recorder, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.activeTask = "Different handoff";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const capsule = await seal(context);

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 3, verified.stderr);
  assert.match(verified.stdout, /^UNVERIFIED\b/u);
});

for (const [name, mutate] of [
  ["a timed-out result", (receipt) => {
    receipt.result.timedOut = true;
  }],
  ["a signaled result", (receipt) => {
    receipt.result.signal = "SIGTERM";
  }],
  ["a spawn error", (receipt) => {
    receipt.result.spawnErrorCode = "E_SPAWN";
  }],
  ["an unexpected result field", (receipt) => {
    receipt.result.unexpected = true;
  }],
  ["an expanded-year timestamp", (receipt) => {
    receipt.startedAt = "+010000-01-01T00:00:00.000Z";
  }],
]) {
  test(`verify refuses ${name} as successful proof`, async () => {
    const context = await makeGitWorkspace();
    assert.equal(
      runObserved(context, process.execPath, "-e", "process.exit(0)").status,
      0,
    );
    const [receiptPath] = await receiptPaths(context);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    mutate(receipt);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const capsule = await seal(context);

    const verified = runCli(
      context.workspace,
      "verify",
      capsule.path.slice(context.workspace.length + 1),
    );
    assert.equal(verified.status, 3, verified.stderr);
    assert.match(verified.stdout, /^UNVERIFIED\b/u);
  });
}

for (const [name, mutate] of [
  [
    "a different HEAD",
    async (context) => {
      await writeFile(join(context.workspace, "tracked.txt"), "next commit\n", "utf8");
      git(context.workspace, "add", "tracked.txt");
      git(context.workspace, "commit", "--quiet", "-m", "next");
    },
  ],
  [
    "unstaged tracked changes",
    async (context) =>
      writeFile(join(context.workspace, "tracked.txt"), "unstaged\n", "utf8"),
  ],
  [
    "staged tracked changes",
    async (context) => {
      await writeFile(join(context.workspace, "tracked.txt"), "staged\n", "utf8");
      git(context.workspace, "add", "tracked.txt");
    },
  ],
  [
    "non-ignored untracked changes",
    async (context) =>
      writeFile(join(context.workspace, "untracked.txt"), "new\n", "utf8"),
  ],
]) {
  test(`verify returns STALE_WORKSPACE after ${name}`, async () => {
    const context = await makeGitWorkspace();
    assert.equal(
      runObserved(context, process.execPath, "-e", "process.exit(0)").status,
      0,
    );
    const capsule = await seal(context);
    await mutate(context);

    const verified = runCli(
      context.workspace,
      "verify",
      capsule.path.slice(context.workspace.length + 1),
    );
    assert.equal(verified.status, 4, verified.stderr);
    assert.match(verified.stdout, /^STALE_WORKSPACE\b/u);
  });
}

test("verify returns STALE_WORKSPACE after a submodule checkout HEAD changes", async () => {
  const submoduleSource = await mkdtemp(
    join(tmpdir(), "flight-recorder-submodule-source-"),
  );
  temporaryDirectories.push(submoduleSource);
  git(submoduleSource, "init", "--quiet");
  git(submoduleSource, "config", "user.email", "submodule@example.invalid");
  git(submoduleSource, "config", "user.name", "Submodule Test");
  await writeFile(join(submoduleSource, "module.txt"), "first\n", "utf8");
  git(submoduleSource, "add", ".");
  git(submoduleSource, "commit", "--quiet", "-m", "first");

  const context = await makeGitWorkspace();
  git(
    context.workspace,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    "--force",
    submoduleSource,
    "vendor/module",
  );
  git(context.workspace, "commit", "--quiet", "-am", "add submodule");
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  const capsule = await seal(context);

  const checkout = join(context.workspace, "vendor", "module");
  git(checkout, "config", "user.email", "submodule@example.invalid");
  git(checkout, "config", "user.name", "Submodule Test");
  await writeFile(join(checkout, "module.txt"), "second\n", "utf8");
  git(checkout, "add", "module.txt");
  git(checkout, "commit", "--quiet", "-m", "second");

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 4, verified.stderr);
  assert.match(verified.stdout, /^STALE_WORKSPACE\b/u);
});

test("tracked symbolic-link targets are fingerprinted as raw bytes", async (t) => {
  if (process.platform === "win32") {
    t.skip("raw POSIX symbolic-link target fixture");
    return;
  }

  const context = await makeGitWorkspace();
  const linkPath = join(context.workspace, "raw-target-link");
  try {
    await symlink(Buffer.from([0xff]), linkPath);
  } catch (error) {
    if (error.code === "EINVAL" || error.code === "EPERM") {
      t.skip(`raw symbolic-link targets unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  git(context.workspace, "add", "raw-target-link");
  git(context.workspace, "commit", "--quiet", "-m", "raw target link");
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  const capsule = await seal(context);

  await unlink(linkPath);
  await symlink(Buffer.from([0xfe]), linkPath);
  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 4, verified.stderr);
  assert.match(verified.stdout, /^STALE_WORKSPACE\b/u);
});

test("ignored file changes do not stale an otherwise valid capsule", async () => {
  const context = await makeGitWorkspace({ ignored: true });
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  const capsule = await seal(context);
  await writeFile(join(context.workspace, "ignored.txt"), "ignored\n", "utf8");

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /^VALID\b/u);
});

test("Git presentation configuration does not stale a capsule", async () => {
  const context = await makeGitWorkspace();
  await writeFile(join(context.workspace, "tracked.txt"), "dirty state\n", "utf8");
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  const capsule = await seal(context);

  git(context.workspace, "config", "color.ui", "always");
  git(context.workspace, "config", "core.quotePath", "false");
  git(context.workspace, "config", "core.fileMode", "false");
  git(context.workspace, "config", "diff.noprefix", "true");
  git(context.workspace, "config", "diff.mnemonicPrefix", "true");
  git(context.workspace, "config", "diff.algorithm", "histogram");

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /^VALID\b/u);
});

test("fingerprinting does not execute textconv, clean-filter, or fsmonitor code", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable-hook fixture");
    return;
  }

  const context = await makeGitWorkspace();
  const marker = join(context.workspace, "git-extension-executed");
  const extension = join(context.workspace, ".git", "hostile-extension.mjs");
  await writeFile(
    extension,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(marker)}, "executed\\n");`,
      'process.stdout.write("hostile extension ran\\n");',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(extension, 0o755);
  await writeFile(
    join(context.workspace, ".gitattributes"),
    "tracked.txt diff=hostile filter=hostile\n",
    "utf8",
  );
  git(context.workspace, "add", ".gitattributes");
  git(context.workspace, "commit", "--quiet", "-m", "attributes");
  git(context.workspace, "config", "diff.hostile.textconv", extension);
  git(context.workspace, "config", "filter.hostile.clean", extension);
  git(context.workspace, "config", "filter.hostile.required", "true");
  git(context.workspace, "config", "core.fsmonitor", extension);
  await writeFile(join(context.workspace, "tracked.txt"), "dirty\n", "utf8");

  const sealed = runCli(
    context.workspace,
    "seal",
    context.recorderArgument,
  );

  assert.equal(sealed.status, 0, sealed.stderr);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("changing only an untracked executable mode stales a capsule", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not expose a stable POSIX executable bit");
    return;
  }

  const context = await makeGitWorkspace();
  const untracked = join(context.workspace, "local-tool.sh");
  await writeFile(untracked, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(untracked, 0o644);
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  const capsule = await seal(context);

  await chmod(untracked, 0o755);
  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 4, verified.stderr);
  assert.match(verified.stdout, /^STALE_WORKSPACE\b/u);
});

test("fingerprinting fails closed while the workspace keeps mutating", async (t) => {
  if (process.platform === "win32") {
    t.skip("continuous-write fixture is POSIX-only");
    return;
  }

  const context = await makeGitWorkspace();
  const mutator = spawn(
    process.execPath,
    [
      "-e",
      [
        'const { writeFileSync } = require("node:fs");',
        "const target = process.argv[1];",
        'process.stdout.write("READY\\n");',
        "const end = Date.now() + 3000;",
        "let count = 0;",
        'while (Date.now() < end) writeFileSync(target, `${count++}\\n`.padEnd(65536, "x"));',
      ].join(""),
      join(context.workspace, "tracked.txt"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolveReady, rejectReady) => {
    mutator.once("error", rejectReady);
    mutator.stdout.once("data", resolveReady);
  });

  const sealed = runCli(
    context.workspace,
    "seal",
    context.recorderArgument,
  );
  mutator.kill("SIGKILL");

  assert.equal(sealed.status, 6, sealed.stderr);
  assert.match(sealed.stdout, /INVALID \[E_WORKSPACE_UNSTABLE\]/u);
});

test("verify returns TAMPERED after a referenced receipt changes", async () => {
  const context = await makeGitWorkspace();
  assert.equal(
    runObserved(context, process.execPath, "-e", "process.exit(0)").status,
    0,
  );
  const capsule = await seal(context);
  const [receiptPath] = await receiptPaths(context);
  await writeFile(receiptPath, '{"changed":true}\n', "utf8");

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 5, verified.stderr);
  assert.match(verified.stdout, /^TAMPERED\b/u);
});

test("verify returns TAMPERED after a sealed handoff artifact changes", async () => {
  const context = await makeGitWorkspace();
  const capsule = await seal(context);
  await writeFile(
    join(context.recorder, "resume.md"),
    "# Resume Pointer\n\nChanged after sealing.\n",
    "utf8",
  );

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 5, verified.stderr);
  assert.match(verified.stdout, /^TAMPERED\b/u);
});

test("verify returns TAMPERED after content-addressed capsule content changes", async () => {
  const context = await makeGitWorkspace();
  const capsule = await seal(context);
  const value = JSON.parse(await readFile(capsule.path, "utf8"));
  value.recorder.task = "altered";
  await writeFile(capsule.path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  const verified = runCli(
    context.workspace,
    "verify",
    capsule.path.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 5, verified.stderr);
  assert.match(verified.stdout, /^TAMPERED\b/u);
});

test("seal rejects an existing capsule path that is a symbolic link", async (t) => {
  const context = await makeGitWorkspace();
  const capsule = await seal(context);
  const decoy = join(context.recorder, "decoy-capsule.json");
  await writeFile(decoy, await readFile(capsule.path));
  await unlink(capsule.path);
  try {
    await symlink(decoy, capsule.path, "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const sealed = runCli(
    context.workspace,
    "seal",
    context.recorderArgument,
  );
  assert.equal(sealed.status, 6, sealed.stderr);
  assert.match(sealed.stdout, /INVALID \[E_IMMUTABLE_TARGET\]/u);
});

test("seal rejects malformed existing task state before creating a capsule", async () => {
  const context = await makeGitWorkspace();
  const statePath = join(context.recorder, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.activeTask = "x".repeat(201);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const sealed = runCli(
    context.workspace,
    "seal",
    context.recorderArgument,
  );
  assert.equal(sealed.status, 6, sealed.stderr);
  assert.match(sealed.stdout, /INVALID \[E_STATE_SCHEMA\]/u);
  await assert.rejects(access(join(context.recorder, "capsules")), {
    code: "ENOENT",
  });
});

test("verify rejects unsupported capsule schemas as INVALID", async () => {
  const context = await makeGitWorkspace();
  const invalid = join(context.workspace, "unsupported.json");
  await writeFile(
    invalid,
    `${JSON.stringify({
      schemaVersion: 99,
      kind: "dev.flight-recorder.handoff",
    })}\n`,
    "utf8",
  );

  const verified = runCli(context.workspace, "verify", "unsupported.json");
  assert.equal(verified.status, 6, verified.stderr);
  assert.match(verified.stdout, /^INVALID\b/u);
});

test("verify rejects malformed workspace structures as INVALID even when re-addressed", async () => {
  const context = await makeGitWorkspace();
  const sealed = await seal(context);
  const capsule = JSON.parse(await readFile(sealed.path, "utf8"));
  capsule.workspace = { version: 1 };
  const { contentDigest: _ignored, ...unsigned } = capsule;
  const digest = sha256(canonicalJson(unsigned));
  capsule.contentDigest = `sha256:${digest}`;
  const malformed = join(context.workspace, `sha256-${digest}.json`);
  await writeFile(malformed, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");

  const verified = runCli(
    context.workspace,
    "verify",
    malformed.slice(context.workspace.length + 1),
  );
  assert.equal(verified.status, 6, verified.stderr);
  assert.match(verified.stdout, /^INVALID\b/u);
});

test("runtime and public schema reject non-portable re-addressed paths", async () => {
  const context = await makeGitWorkspace();
  const sealed = await seal(context);
  const source = JSON.parse(await readFile(sealed.path, "utf8"));
  const schema = JSON.parse(
    await readFile(join(repositoryRoot, "schema", "handoff-v1.schema.json"), "utf8"),
  );
  const relativePathPattern = new RegExp(schema.$defs.relativePath.pattern, "u");
  const hostilePaths = [
    "ops//verify-handoff",
    "ops/verify-handoff/",
    "C:/ops/verify-handoff",
    "ops/verify-handoff:stream",
    "ops/\u0001verify-handoff",
    "ops/\u2028/../verify-handoff",
    "ops/\u2028:stream",
  ];

  for (const [index, hostilePath] of hostilePaths.entries()) {
    assert.equal(relativePathPattern.test(hostilePath), false, hostilePath);
    const capsule = structuredClone(source);
    capsule.recorder.path = hostilePath;
    const { contentDigest: _ignored, ...unsigned } = capsule;
    const digest = sha256(canonicalJson(unsigned));
    capsule.contentDigest = `sha256:${digest}`;
    const hostile = join(context.workspace, `sha256-${digest}.json`);
    await writeFile(hostile, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");

    const verified = runCli(
      context.workspace,
      "verify",
      hostile.slice(context.workspace.length + 1),
    );
    assert.equal(verified.status, 6, `${index}: ${verified.stderr}`);
    assert.match(verified.stdout, /^INVALID \[E_CAPSULE_SCHEMA\]/u);
  }
});

for (const field of ["artifacts", "receipts"]) {
  test(`verify rejects null and non-object ${field} entries as INVALID`, async () => {
    const context = await makeGitWorkspace();
    for (const [kind, entry] of [
      ["null", null],
      ["number", 7],
    ]) {
      const hostile = join(context.workspace, `hostile-${field}-${kind}.json`);
      const capsule = {
        schemaVersion: 1,
        kind: "dev.flight-recorder.handoff",
        recorder: {
          path: context.recorderArgument,
          task: "Verify handoff",
        },
        workspace: {},
        artifacts: [],
        receipts: [],
        contentDigest: `sha256:${"0".repeat(64)}`,
      };
      capsule[field] = [entry];
      await writeFile(hostile, `${JSON.stringify(capsule)}\n`, "utf8");

      const verified = runCli(
        context.workspace,
        "verify",
        hostile.slice(context.workspace.length + 1),
      );
      assert.equal(verified.status, 6, verified.stderr);
      assert.match(verified.stdout, /^INVALID\b/u);
    }
  });
}

test("seal rejects a recorder path that traverses a symlink", async (t) => {
  const context = await makeGitWorkspace();
  const alias = join(context.workspace, "recorder-link");
  try {
    await symlink(context.recorder, alias, "dir");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const sealed = runCli(context.workspace, "seal", "recorder-link");
  assert.equal(sealed.status, 6);
  assert.match(sealed.stdout, /^INVALID\b/u);
  await assert.rejects(access(join(context.recorder, "capsules")), {
    code: "ENOENT",
  });
});

test("seal rejects recorder paths outside the current workspace", async () => {
  const context = await makeGitWorkspace();
  const outside = await mkdtemp(join(tmpdir(), "flight-recorder-outside-"));
  temporaryDirectories.push(outside);
  await mkdir(join(outside, "recorder"));

  const sealed = runCli(
    context.workspace,
    "seal",
    join("..", basename(outside), "recorder"),
  );
  assert.equal(sealed.status, 6);
  assert.match(sealed.stdout, /^INVALID\b/u);
  await assert.rejects(access(join(outside, "recorder", "capsules")), {
    code: "ENOENT",
  });
});

test(
  "Windows can observe an explicit cmd.exe npm invocation without implicit shell mode",
  { skip: process.platform !== "win32" },
  async () => {
    const context = await makeGitWorkspace();
    const result = runObserved(
      context,
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "npm --version",
    );

    assert.equal(result.status, 0, result.stderr);
    const [receiptPath] = await receiptPaths(context);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.deepEqual(receipt.command.argv, [
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "npm --version",
    ]);
  },
);
