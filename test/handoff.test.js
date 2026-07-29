import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

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
  const script = [
    "process.stdout.write(process.env.TEST_STDOUT);",
    "process.stderr.write(process.env.TEST_STDERR);",
    "if (process.argv[1] !== process.env.EXPECTED_LITERAL) process.exit(9);",
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
    ],
    {
      env: {
        ...process.env,
        EXPECTED_LITERAL: literalArgument,
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
  assert.equal(receiptText.includes("github.com"), false);
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

test("run bounds execution with an explicit timeout and records it", async () => {
  const context = await makeGitWorkspace();
  const result = runCli(
    context.workspace,
    "run",
    context.recorderArgument,
    "--timeout",
    "50",
    "--",
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000)",
  );

  assert.equal(result.status, 124);
  const [receiptPath] = await receiptPaths(context);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.result.timedOut, true);
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
