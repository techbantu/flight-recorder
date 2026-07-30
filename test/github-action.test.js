import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { canonicalJson, sha256 } from "../src/integrity.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const actionPath = join(repositoryRoot, "action", "index.js");
const attestationPolicyPath = join(
  repositoryRoot,
  "scripts",
  "verify-attestation-policy.js",
);
const cliPath = join(repositoryRoot, "bin", "fr.js");
const temporaryDirectories = [];

const run = (cwd, executable, arguments_, env = process.env) =>
  spawnSync(executable, arguments_, {
    cwd,
    encoding: "utf8",
    env,
  });

const git = (cwd, ...arguments_) => {
  const result = run(cwd, "git", arguments_);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const makeWorkspace = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "flight-recorder-action-workspace-"));
  const runner = await mkdtemp(join(tmpdir(), "flight-recorder-action-runner-"));
  temporaryDirectories.push(workspace, runner);

  git(workspace, "init", "--quiet");
  git(workspace, "config", "user.email", "flight-recorder@example.invalid");
  git(workspace, "config", "user.name", "Flight Recorder Test");
  await writeFile(join(workspace, "tracked.txt"), "baseline\n", "utf8");
  git(workspace, "add", "tracked.txt");
  git(workspace, "commit", "--quiet", "-m", "baseline");

  return {
    workspace,
    runner,
    output: join(runner, "output"),
    summary: join(runner, "summary"),
  };
};

const actionEnvironment = (context, argv) => ({
  ...process.env,
  GITHUB_OUTPUT: context.output,
  GITHUB_STEP_SUMMARY: context.summary,
  GITHUB_WORKSPACE: context.workspace,
  RUNNER_TEMP: context.runner,
  INPUT_ARGV: argv,
  INPUT_TASK: "Verify the reviewed checkout",
});

const runAction = (context, argv) =>
  run(
    context.workspace,
    process.execPath,
    [actionPath],
    actionEnvironment(context, argv),
  );

const parseOutputs = async (path) =>
  Object.fromEntries(
    (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1, line);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("the Action metadata uses the current Node runtime without lifecycle hooks", async () => {
  const metadata = await readFile(join(repositoryRoot, "action.yml"), "utf8");

  assert.match(metadata, /^runs:\n  using: node24\n  main: action\/index\.js$/mu);
  assert.doesNotMatch(metadata, /^\s+(pre|post):/mu);
});

test("the Action records exact inert argv and emits a locally valid capsule", async () => {
  const context = await makeWorkspace();
  const sentinel = join(context.workspace, "shell-syntax-must-not-run");
  const literal = "$(touch shell-syntax-must-not-run)";
  const actionControlKeys = [
    "ACTIONS_CACHE_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_RESULTS_URL",
    "ACTIONS_RUNTIME_TOKEN",
    "GITHUB_ARTIFACTS",
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STATE",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_TOKEN",
  ];
  const script = [
    "if (process.argv[1] !== process.env.EXPECTED_LITERAL) process.exit(9);",
    `if (${JSON.stringify(
      actionControlKeys,
    )}.some((key) => process.env[key] !== undefined)) process.exit(8);`,
    'process.stdout.write("checked\\n");',
  ].join("");
  const argv = [process.execPath, "-e", script, literal];
  const result = run(
    context.workspace,
    process.execPath,
    [actionPath],
    {
      ...actionEnvironment(context, JSON.stringify(argv)),
      EXPECTED_LITERAL: literal,
      ...Object.fromEntries(
        actionControlKeys
          .filter(
            (key) =>
              key !== "GITHUB_OUTPUT" && key !== "GITHUB_STEP_SUMMARY",
          )
          .map((key) => [key, "must-not-reach-child"]),
      ),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "checked\n");
  assert.equal(result.stderr, "");
  await assert.rejects(access(sentinel), { code: "ENOENT" });

  const outputs = await parseOutputs(context.output);
  assert.equal(outputs.outcome, "VALID");
  assert.match(outputs["capsule-content-digest"], /^sha256:[a-f0-9]{64}$/u);
  assert.match(outputs["capsule-file-digest"], /^sha256:[a-f0-9]{64}$/u);
  assert.match(outputs["workspace-head"], /^[a-f0-9]{40,64}$/u);
  assert.match(
    outputs["capsule-path"],
    /[/\\]\.flight-recorder[/\\]evidence-[a-f0-9-]+[/\\]capsules[/\\]sha256-[a-f0-9]{64}\.json$/u,
  );
  assert.match(
    outputs["recorder-path"],
    /[/\\]\.flight-recorder[/\\]evidence-[a-f0-9-]+$/u,
  );
  assert.match(outputs["receipt-path"], /[/\\]receipts[/\\]receipt-[a-f0-9-]+\.json$/u);
  assert.match(outputs["predicate-path"], /[/\\]ci-verification-v1\.json$/u);
  assert.match(
    outputs["attestation-bundle-path"],
    /[/\\]flight-recorder-attestation-[^/\\]+$/u,
  );
  assert.equal(
    outputs["attestation-capsule-path"],
    join(outputs["attestation-bundle-path"], "capsule.json"),
  );
  assert.equal(
    outputs["attestation-predicate-path"],
    join(outputs["attestation-bundle-path"], "predicate.json"),
  );
  assert.deepEqual(
    (await readdir(outputs["attestation-bundle-path"])).sort(),
    ["capsule.json", "predicate.json"],
  );
  for (const path of [
    outputs["attestation-capsule-path"],
    outputs["attestation-predicate-path"],
  ]) {
    const status = await lstat(path);
    assert.equal(status.isFile(), true);
    assert.equal(status.isSymbolicLink(), false);
  }
  const capsuleBytes = await readFile(outputs["capsule-path"]);
  const stagedCapsule = JSON.parse(capsuleBytes.toString("utf8"));
  assert.equal(stagedCapsule.recorder.task, "Verify the reviewed checkout");
  assert.equal(
    outputs["capsule-file-digest"],
    `sha256:${createHash("sha256").update(capsuleBytes).digest("hex")}`,
  );
  assert.notEqual(
    outputs["capsule-file-digest"],
    outputs["capsule-content-digest"],
  );
  assert.deepEqual(
    await readFile(outputs["attestation-capsule-path"]),
    capsuleBytes,
  );

  const verified = run(
    context.workspace,
    process.execPath,
    [cliPath, "verify", outputs["capsule-path"]],
  );
  assert.equal(
    verified.status,
    0,
    `${verified.stdout}${verified.stderr}`,
  );
  assert.match(verified.stdout, /^VALID\b/u);

  const receiptDirectory = join(
    outputs["recorder-path"],
    "receipts",
  );
  const [receiptName] = await readdir(receiptDirectory);
  const receipt = JSON.parse(
    await readFile(join(receiptDirectory, receiptName), "utf8"),
  );
  assert.deepEqual(receipt.command.argv, argv);
  assert.equal(
    JSON.stringify(receipt.workspaceBefore),
    JSON.stringify(receipt.workspaceAfter),
  );

  const predicate = JSON.parse(await readFile(outputs["predicate-path"], "utf8"));
  const predicateBytes = await readFile(outputs["predicate-path"]);
  assert.equal(
    outputs["predicate-file-digest"],
    `sha256:${createHash("sha256").update(predicateBytes).digest("hex")}`,
  );
  assert.equal(
    await readFile(outputs["attestation-predicate-path"], "utf8"),
    await readFile(outputs["predicate-path"], "utf8"),
  );
  const predicateSchema = JSON.parse(
    await readFile(
      join(repositoryRoot, "schema", "ci-verification-v1.schema.json"),
      "utf8",
    ),
  );
  assert.equal(
    predicateSchema.$id,
    "https://github.com/techbantu/flight-recorder/attestation/ci-verification/v1",
  );
  assert.deepEqual(
    Object.keys(predicate).sort(),
    predicateSchema.required.sort(),
  );
  assert.equal(predicate.kind, "dev.flight-recorder.ci-verification");
  assert.equal(predicate.outcome, "VALID");
  assert.equal(
    predicate.capsuleContentDigest,
    outputs["capsule-content-digest"],
  );
  assert.equal(predicate.capsuleFileDigest, outputs["capsule-file-digest"]);
  assert.equal(predicate.workspaceHead, outputs["workspace-head"]);
  assert.deepEqual(predicate.policy, {
    cleanCloneVerified: true,
    spawnShell: false,
    workspaceSnapshotsMatched: true,
  });
  const predicateText = JSON.stringify(predicate);
  assert.equal(predicateText.includes(literal), false);
  assert.equal(predicateText.includes(script), false);
  assert.equal(predicateText.includes("Verify the reviewed checkout"), false);
  assert.equal("argv" in predicate, false);
  assert.equal("environment" in predicate, false);
  assert.equal("stdout" in predicate, false);
  assert.equal("stderr" in predicate, false);
  for (const field of [
    "capsuleContentDigest",
    "capsuleFileDigest",
    "workspaceFingerprintDigest",
    "commandArgvDigest",
    "receiptFileDigest",
  ]) {
    assert.match(
      predicate[field],
      new RegExp(predicateSchema.$defs.sha256Digest.pattern, "u"),
      field,
    );
  }

  const summary = await readFile(context.summary, "utf8");
  assert.match(summary, /Flight Recorder evidence/u);
  assert.match(summary, /VALID/u);
  assert.match(
    summary,
    new RegExp(outputs["capsule-content-digest"], "u"),
  );
  assert.equal(summary.includes(literal), false);
  assert.equal(summary.includes(script), false);
  assert.equal(summary.includes("Verify the reviewed checkout"), false);
});

test("the attestation policy enforces one subject and exact capsule relationships", async () => {
  const context = await makeWorkspace();
  const actionResult = runAction(
    context,
    JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
  );
  assert.equal(actionResult.status, 0, actionResult.stderr);
  const outputs = await parseOutputs(context.output);
  const predicate = JSON.parse(
    await readFile(outputs["attestation-predicate-path"], "utf8"),
  );
  const verification = [
    {
      verificationResult: {
        statement: {
          subject: [
            {
              name: "capsule.json",
              digest: {
                sha256: outputs["capsule-file-digest"].slice("sha256:".length),
              },
            },
          ],
          predicateType:
            "https://github.com/techbantu/flight-recorder/attestation/ci-verification/v1",
          predicate,
        },
      },
    },
  ];
  const verificationPath = join(context.runner, "verification.json");
  await writeFile(
    verificationPath,
    `${JSON.stringify(verification)}\n`,
    "utf8",
  );
  const valid = run(
    context.workspace,
    process.execPath,
    [
      attestationPolicyPath,
      verificationPath,
      outputs["attestation-capsule-path"],
      outputs["workspace-head"],
    ],
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, "ATTESTATION_POLICY_VALID\n");

  const wrongReceiptDigest = structuredClone(verification);
  wrongReceiptDigest[0].verificationResult.statement.predicate.receiptFileDigest =
    `sha256:${"f".repeat(64)}`;
  await writeFile(
    verificationPath,
    `${JSON.stringify(wrongReceiptDigest)}\n`,
    "utf8",
  );
  const mismatchedReceipt = run(
    context.workspace,
    process.execPath,
    [
      attestationPolicyPath,
      verificationPath,
      outputs["attestation-capsule-path"],
      outputs["workspace-head"],
    ],
  );
  assert.equal(mismatchedReceipt.status, 6, mismatchedReceipt.stderr);
  assert.match(mismatchedReceipt.stderr, /receipt digest does not match/u);

  const originalCapsule = JSON.parse(
    await readFile(outputs["attestation-capsule-path"], "utf8"),
  );
  for (const receipts of [
    [],
    [
      ...originalCapsule.receipts,
      {
        ...originalCapsule.receipts[0],
        path: "receipts/second-receipt.json",
      },
    ],
  ]) {
    const alteredCapsule = structuredClone(originalCapsule);
    alteredCapsule.receipts = receipts;
    const { contentDigest: _oldDigest, ...unsignedCapsule } = alteredCapsule;
    alteredCapsule.contentDigest =
      `sha256:${sha256(canonicalJson(unsignedCapsule))}`;
    const alteredCapsuleBytes = Buffer.from(
      `${JSON.stringify(alteredCapsule, null, 2)}\n`,
      "utf8",
    );
    const alteredCapsulePath = join(
      context.runner,
      `capsule-${receipts.length}-receipts.json`,
    );
    await writeFile(alteredCapsulePath, alteredCapsuleBytes);
    const alteredFileDigest = createHash("sha256")
      .update(alteredCapsuleBytes)
      .digest("hex");
    const alteredVerification = structuredClone(verification);
    const alteredStatement =
      alteredVerification[0].verificationResult.statement;
    alteredStatement.subject[0].digest.sha256 = alteredFileDigest;
    alteredStatement.predicate.capsuleContentDigest =
      alteredCapsule.contentDigest;
    alteredStatement.predicate.capsuleFileDigest =
      `sha256:${alteredFileDigest}`;
    await writeFile(
      verificationPath,
      `${JSON.stringify(alteredVerification)}\n`,
      "utf8",
    );
    const wrongReceiptCount = run(
      context.workspace,
      process.execPath,
      [
        attestationPolicyPath,
        verificationPath,
        alteredCapsulePath,
        outputs["workspace-head"],
      ],
    );
    assert.equal(wrongReceiptCount.status, 6, wrongReceiptCount.stderr);
    assert.match(
      wrongReceiptCount.stderr,
      /must summarize exactly one receipt/u,
    );
  }

  await writeFile(
    verificationPath,
    `${JSON.stringify([...verification, structuredClone(verification[0])])}\n`,
    "utf8",
  );
  const duplicate = run(
    context.workspace,
    process.execPath,
    [
      attestationPolicyPath,
      verificationPath,
      outputs["attestation-capsule-path"],
      outputs["workspace-head"],
    ],
  );
  assert.equal(duplicate.status, 6, duplicate.stderr);
  assert.match(duplicate.stderr, /exactly one verified attestation/u);

  const wrongPredicate = structuredClone(verification.slice(0, 1));
  wrongPredicate[0].verificationResult.statement.predicate.capsuleFileDigest =
    `sha256:${"0".repeat(64)}`;
  await writeFile(
    verificationPath,
    `${JSON.stringify(wrongPredicate)}\n`,
    "utf8",
  );
  const mismatched = run(
    context.workspace,
    process.execPath,
    [
      attestationPolicyPath,
      verificationPath,
      outputs["attestation-capsule-path"],
      outputs["workspace-head"],
    ],
  );
  assert.equal(mismatched.status, 6, mismatched.stderr);
  assert.match(mismatched.stderr, /capsule file digest does not match/u);

  const malformedType = structuredClone(verification.slice(0, 1));
  malformedType[0].verificationResult.statement.predicate.commandArgvDigest = [
    predicate.commandArgvDigest,
  ];
  await writeFile(
    verificationPath,
    `${JSON.stringify(malformedType)}\n`,
    "utf8",
  );
  const malformed = run(
    context.workspace,
    process.execPath,
    [
      attestationPolicyPath,
      verificationPath,
      outputs["attestation-capsule-path"],
      outputs["workspace-head"],
    ],
  );
  assert.equal(malformed.status, 6, malformed.stderr);
  assert.match(malformed.stderr, /does not satisfy policy schema v1/u);
});

test("the Action rejects malformed or unsafe argv before creating evidence", async () => {
  const invalidInputs = [
    ["not JSON", "npm test", "E_ACTION_ARGV_JSON"],
    ["object", '{"command":"npm test"}', "E_ACTION_ARGV_TYPE"],
    ["empty", "[]", "E_ACTION_ARGV_EMPTY"],
    ["empty executable", '[""]', "E_ACTION_ARGV_EXECUTABLE"],
    ["non-string member", '["node",7]', "E_ACTION_ARGV_MEMBER"],
    [
      "too many members",
      JSON.stringify(Array.from({ length: 129 }, () => "x")),
      "E_ACTION_ARGV_COUNT",
    ],
    [
      "too many bytes",
      JSON.stringify(["node", "x".repeat(17 * 1024)]),
      "E_ACTION_ARGV_SIZE",
    ],
  ];

  for (const [label, input, code] of invalidInputs) {
    const context = await makeWorkspace();
    const result = runAction(context, input);

    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`\\[${code}\\]`, "u"), label);
    assert.deepEqual(await readdir(context.workspace), [".git", "tracked.txt"]);
    await assert.rejects(access(context.output), { code: "ENOENT" });
    await assert.rejects(access(context.summary), { code: "ENOENT" });
  }
});

test("the Action preserves child failure and never reports valid evidence", async () => {
  const context = await makeWorkspace();
  const result = runAction(
    context,
    JSON.stringify([process.execPath, "-e", "process.exit(7)"]),
  );

  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /\[E_ACTION_COMMAND\]/u);
  await assert.rejects(access(context.output), { code: "ENOENT" });
  await assert.rejects(access(context.summary), { code: "ENOENT" });

  const [evidenceDirectory] = await readdir(
    join(context.workspace, ".flight-recorder"),
  );
  const evidencePath = join(
    context.workspace,
    ".flight-recorder",
    evidenceDirectory,
  );
  assert.deepEqual((await readdir(evidencePath)).sort(), [
    "checks.md",
    "decisions.log",
    "receipts",
    "resume.md",
    "state.json",
  ]);
  assert.equal((await readdir(join(evidencePath, "receipts"))).length, 1);
});

test("the Action fails closed when the observed command mutates source", async () => {
  const context = await makeWorkspace();
  const mutation = [
    'require("node:fs").writeFileSync("tracked.txt", "changed\\n");',
  ].join("");
  const result = runAction(
    context,
    JSON.stringify([process.execPath, "-e", mutation]),
  );

  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /\[E_ACTION_WORKSPACE_MUTATED\]/u);
  assert.equal(await readFile(join(context.workspace, "tracked.txt"), "utf8"), "changed\n");
  await assert.rejects(access(context.output), { code: "ENOENT" });
  await assert.rejects(access(context.summary), { code: "ENOENT" });
});

test("the Action reports matching endpoint snapshots without claiming continuous immutability", async () => {
  const context = await makeWorkspace();
  const transientMutation = [
    'const fs = require("node:fs");',
    'const original = fs.readFileSync("tracked.txt");',
    'fs.writeFileSync("tracked.txt", "temporary\\n");',
    'fs.writeFileSync("tracked.txt", original);',
  ].join("");
  const result = runAction(
    context,
    JSON.stringify([process.execPath, "-e", transientMutation]),
  );

  assert.equal(result.status, 0, result.stderr);
  const outputs = await parseOutputs(context.output);
  const predicate = JSON.parse(
    await readFile(outputs["predicate-path"], "utf8"),
  );
  assert.deepEqual(predicate.policy, {
    cleanCloneVerified: true,
    spawnShell: false,
    workspaceSnapshotsMatched: true,
  });
  assert.equal("workspaceUnchanged" in predicate.policy, false);
});

test("the Action rejects a new non-ignored file but documents the ignored-file boundary", async () => {
  const changed = await makeWorkspace();
  const createUntracked = [
    'require("node:fs").writeFileSync("generated.txt", "generated\\n");',
  ].join("");
  const changedResult = runAction(
    changed,
    JSON.stringify([process.execPath, "-e", createUntracked]),
  );

  assert.equal(changedResult.status, 4, changedResult.stderr);
  assert.match(changedResult.stderr, /\[E_ACTION_WORKSPACE_MUTATED\]/u);

  const ignored = await makeWorkspace();
  await writeFile(join(ignored.workspace, ".gitignore"), "ignored.txt\n", "utf8");
  git(ignored.workspace, "add", ".gitignore");
  git(ignored.workspace, "commit", "--quiet", "-m", "ignore local output");
  const createIgnored = [
    'require("node:fs").writeFileSync("ignored.txt", "ignored\\n");',
  ].join("");
  const ignoredResult = runAction(
    ignored,
    JSON.stringify([process.execPath, "-e", createIgnored]),
  );

  assert.equal(ignoredResult.status, 0, ignoredResult.stderr);
  const outputs = await parseOutputs(ignored.output);
  assert.equal(outputs.outcome, "VALID");
});

test("the attestation bundle excludes unexpected recorder symlinks", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation requires host-specific privileges");
    return;
  }

  const context = await makeWorkspace();
  const outside = join(context.runner, "must-not-upload.txt");
  await writeFile(outside, "private runner content\n", "utf8");
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const recorder = fs.readdirSync(".flight-recorder")[0];',
    'fs.symlinkSync(process.env.LEAK_TARGET, path.join(".flight-recorder", recorder, "leak"));',
  ].join("");
  const result = run(
    context.workspace,
    process.execPath,
    [actionPath],
    {
      ...actionEnvironment(
        context,
        JSON.stringify([process.execPath, "-e", script]),
      ),
      LEAK_TARGET: outside,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const outputs = await parseOutputs(context.output);
  assert.deepEqual(
    (await readdir(outputs["attestation-bundle-path"])).sort(),
    ["capsule.json", "predicate.json"],
  );
  assert.equal(
    (await readFile(outputs["attestation-capsule-path"], "utf8")).includes(
      "private runner content",
    ),
    false,
  );
  assert.equal(
    (await readFile(outputs["attestation-predicate-path"], "utf8")).includes(
      "private runner content",
    ),
    false,
  );
});

test("the Action rejects pre-existing staged, unstaged, and untracked content before command execution", async () => {
  const scenarios = [
    [
      "unstaged",
      async (workspace) =>
        writeFile(join(workspace, "tracked.txt"), "unstaged\n", "utf8"),
    ],
    [
      "staged",
      async (workspace) => {
        await writeFile(join(workspace, "tracked.txt"), "staged\n", "utf8");
        git(workspace, "add", "tracked.txt");
      },
    ],
    [
      "untracked",
      async (workspace) =>
        writeFile(join(workspace, "pre-existing.txt"), "untracked\n", "utf8"),
    ],
  ];

  for (const [label, arrange] of scenarios) {
    const context = await makeWorkspace();
    await arrange(context.workspace);
    const sentinel = join(context.workspace, `dirty-${label}-command-ran`);
    const command = [
      `require("node:fs").writeFileSync(${JSON.stringify(
        `dirty-${label}-command-ran`,
      )}, "unsafe\\n");`,
    ].join("");
    const result = runAction(
      context,
      JSON.stringify([process.execPath, "-e", command]),
    );

    assert.equal(result.status, 4, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /\[E_ACTION_WORKSPACE_DIRTY\]/u, label);
    assert.match(result.stderr, /no command was executed/u, label);
    await assert.rejects(access(sentinel), { code: "ENOENT" });
    await assert.rejects(access(context.output), { code: "ENOENT" });
    await assert.rejects(access(context.summary), { code: "ENOENT" });
  }
});

test("the clean-workspace guard rejects executable Git filters before they run", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable-hook fixture");
    return;
  }

  const context = await makeWorkspace();
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
  git(context.workspace, "config", "extensions.worktreeConfig", "true");
  git(context.workspace, "config", "--worktree", "filter.hostile.clean", extension);
  git(context.workspace, "config", "--worktree", "filter.hostile.required", "true");
  git(context.workspace, "config", "core.fsmonitor", extension);
  await writeFile(join(context.workspace, "tracked.txt"), "changed!\n", "utf8");

  const result = run(
    context.workspace,
    process.execPath,
    [actionPath],
    {
      ...actionEnvironment(
        context,
        JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
      ),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-reach-git",
      GITHUB_TOKEN: "must-not-reach-git",
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[E_GIT_FILTER\]/u);
  assert.match(result.stderr, /observed command was not executed/u);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("the clean-workspace guard rejects filters in initialized submodules", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable-filter fixture");
    return;
  }

  const submoduleSource = await mkdtemp(
    join(tmpdir(), "flight-recorder-action-submodule-source-"),
  );
  temporaryDirectories.push(submoduleSource);
  git(submoduleSource, "init", "--quiet");
  git(submoduleSource, "config", "user.email", "flight-recorder@example.invalid");
  git(submoduleSource, "config", "user.name", "Flight Recorder Test");
  await writeFile(join(submoduleSource, "tracked.txt"), "tracked\n", "utf8");
  git(submoduleSource, "add", "tracked.txt");
  git(submoduleSource, "commit", "--quiet", "-m", "baseline");

  const context = await makeWorkspace();
  const addSubmodule = run(context.workspace, "git", [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    submoduleSource,
    "test-submodule",
  ]);
  assert.equal(addSubmodule.status, 0, addSubmodule.stderr);
  git(context.workspace, "add", ".gitmodules", "test-submodule");
  git(context.workspace, "commit", "--quiet", "-m", "add submodule");

  const submodule = join(context.workspace, "test-submodule");
  const marker = join(context.runner, "submodule-filter-executed");
  const commandMarker = join(context.runner, "observed-command-executed");
  const filter = join(context.runner, "hostile-submodule-filter.mjs");
  await writeFile(
    filter,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(marker)}, "executed\\n");`,
      'process.stdin.pipe(process.stdout);',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(filter, 0o755);
  await writeFile(
    join(submodule, ".gitattributes"),
    "tracked.txt filter=hostile\n",
    "utf8",
  );
  git(submodule, "add", ".gitattributes");
  git(submodule, "config", "user.email", "flight-recorder@example.invalid");
  git(submodule, "config", "user.name", "Flight Recorder Test");
  git(submodule, "commit", "--quiet", "-m", "attributes");
  git(context.workspace, "add", "test-submodule");
  git(context.workspace, "commit", "--quiet", "-m", "update submodule");
  git(submodule, "config", "filter.hostile.clean", filter);
  git(submodule, "config", "filter.hostile.required", "true");
  await writeFile(join(submodule, "tracked.txt"), "changed\n", "utf8");

  const command = [
    `require("node:fs").writeFileSync(${JSON.stringify(
      commandMarker,
    )}, "executed\\n");`,
  ].join("");
  const result = run(
    context.workspace,
    process.execPath,
    [actionPath],
    {
      ...actionEnvironment(
        context,
        JSON.stringify([process.execPath, "-e", command]),
      ),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-reach-git",
      GITHUB_TOKEN: "must-not-reach-git",
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[E_SUBMODULE_INITIALIZED\]/u);
  assert.match(result.stderr, /observed command was not executed/u);
  await assert.rejects(access(marker), { code: "ENOENT" });
  await assert.rejects(access(commandMarker), { code: "ENOENT" });
});

test("the clean-workspace guard rejects Git configuration and index concealment", async (t) => {
  const scenarios = [
    [
      "core.excludesFile",
      async (context) => {
        const excludes = join(context.workspace, ".git", "local-excludes");
        await writeFile(excludes, "hidden.txt\n", "utf8");
        git(context.workspace, "config", "core.excludesFile", excludes);
        await writeFile(join(context.workspace, "hidden.txt"), "hidden\n", "utf8");
      },
    ],
    [
      "assume-unchanged",
      async (context) => {
        git(context.workspace, "update-index", "--assume-unchanged", "tracked.txt");
        await writeFile(join(context.workspace, "tracked.txt"), "concealed\n", "utf8");
      },
    ],
    [
      "skip-worktree",
      async (context) => {
        git(context.workspace, "update-index", "--skip-worktree", "tracked.txt");
        await writeFile(join(context.workspace, "tracked.txt"), "concealed\n", "utf8");
      },
    ],
  ];
  if (process.platform !== "win32") {
    scenarios.push([
      "core.fileMode",
      async (context) => {
        git(context.workspace, "config", "core.fileMode", "false");
        await chmod(join(context.workspace, "tracked.txt"), 0o755);
      },
    ]);
  }

  for (const [label, arrange] of scenarios) {
    const context = await makeWorkspace();
    await arrange(context);
    const sentinel = join(context.workspace, `concealed-${label}-command-ran`);
    const command = [
      `require("node:fs").writeFileSync(${JSON.stringify(
        `concealed-${label}-command-ran`,
      )}, "unsafe\\n");`,
    ].join("");
    const result = runAction(
      context,
      JSON.stringify([process.execPath, "-e", command]),
    );

    assert.equal(result.status, 4, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /\[E_ACTION_WORKSPACE_DIRTY\]/u, label);
    await assert.rejects(access(sentinel), { code: "ENOENT" });
  }

  if (process.platform !== "win32") {
    const context = await makeWorkspace();
    await writeFile(join(context.workspace, "target.txt"), "target\n", "utf8");
    await unlink(join(context.workspace, "tracked.txt"));
    await symlink("target.txt", join(context.workspace, "tracked.txt"));
    git(context.workspace, "add", "--all");
    git(context.workspace, "commit", "--quiet", "-m", "track symlink");
    git(context.workspace, "config", "core.symlinks", "false");
    await unlink(join(context.workspace, "tracked.txt"));
    await writeFile(join(context.workspace, "tracked.txt"), "target.txt", "utf8");

    const result = runAction(
      context,
      JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
    );
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /\[E_ACTION_WORKSPACE_DIRTY\]/u);
  }

  const caseContext = await makeWorkspace();
  await rename(
    join(caseContext.workspace, "tracked.txt"),
    join(caseContext.workspace, "File"),
  );
  git(caseContext.workspace, "add", "--all");
  git(caseContext.workspace, "commit", "--quiet", "-m", "track case-sensitive path");
  git(caseContext.workspace, "config", "core.ignoreCase", "true");
  await rename(
    join(caseContext.workspace, "File"),
    join(caseContext.workspace, "file"),
  );
  const originalCaseStillResolves = await access(
    join(caseContext.workspace, "File"),
  ).then(
    () => true,
    () => false,
  );
  if (originalCaseStillResolves) {
    t.diagnostic("case-only concealment is not distinguishable on this filesystem");
  } else {
    const result = runAction(
      caseContext,
      JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
    );
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /\[E_ACTION_WORKSPACE_DIRTY\]/u);
  }
});

test("trusted default-branch evidence rejects a mismatched GitHub SHA", async () => {
  const context = await makeWorkspace();
  const sentinel = join(context.workspace, "wrong-ref-command-ran");
  const command = [
    'require("node:fs").writeFileSync("wrong-ref-command-ran", "unsafe\\n");',
  ].join("");
  const result = run(
    context.workspace,
    process.execPath,
    [actionPath],
    {
      ...actionEnvironment(
        context,
        JSON.stringify([process.execPath, "-e", command]),
      ),
      GITHUB_EVENT_NAME: "push",
      GITHUB_SHA: "0".repeat(40),
    },
  );

  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /\[E_ACTION_HEAD_MISMATCH\]/u);
  assert.match(result.stderr, /no command was executed/u);
  await assert.rejects(access(sentinel), { code: "ENOENT" });
  assert.deepEqual(await readdir(context.workspace), [".git", "tracked.txt"]);
  await assert.rejects(access(context.output), { code: "ENOENT" });
  await assert.rejects(access(context.summary), { code: "ENOENT" });
});

test("the emitted evidence restores and verifies in a clean clone of the exact HEAD", async () => {
  const context = await makeWorkspace();
  const result = runAction(
    context,
    JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
  );
  assert.equal(result.status, 0, result.stderr);
  const outputs = await parseOutputs(context.output);
  const restored = await mkdtemp(join(tmpdir(), "flight-recorder-action-restore-"));
  temporaryDirectories.push(restored);
  const clone = join(restored, "clone");
  const cloneResult = run(restored, "git", [
    "clone",
    "--quiet",
    "--no-local",
    "--no-checkout",
    context.workspace,
    clone,
  ]);
  assert.equal(cloneResult.status, 0, cloneResult.stderr);
  const checkoutResult = run(clone, "git", [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "checkout",
    "--quiet",
    "--detach",
    outputs["workspace-head"],
    "--",
  ]);
  assert.equal(checkoutResult.status, 0, checkoutResult.stderr);

  const canonicalWorkspace = await realpath(context.workspace);
  const relativeRecorder = outputs["recorder-path"].slice(
    canonicalWorkspace.length + 1,
  );
  const relativeCapsule = outputs["capsule-path"].slice(
    canonicalWorkspace.length + 1,
  );
  await mkdir(join(clone, dirname(relativeRecorder)), { recursive: true });
  const restoredRecorder = join(clone, relativeRecorder);
  await cp(outputs["recorder-path"], restoredRecorder, {
    recursive: true,
  });
  const restoredCapsule = join(clone, relativeCapsule);
  await access(join(restoredRecorder, "state.json"));
  await access(restoredCapsule);
  const capsule = JSON.parse(await readFile(restoredCapsule, "utf8"));
  assert.equal(
    capsule.recorder.path,
    relativeRecorder.split("\\").join("/"),
  );

  const verified = run(
    clone,
    process.execPath,
    [cliPath, "verify", relativeCapsule],
  );
  assert.equal(
    verified.status,
    0,
    `${verified.stdout}${verified.stderr}`,
  );
  assert.match(verified.stdout, /^VALID\b/u);
});

test("the Action rejects a missing GitHub workspace before spawning", async () => {
  const context = await makeWorkspace();
  const sentinel = join(context.workspace, "must-not-run");
  const environment = {
    ...process.env,
    GITHUB_OUTPUT: context.output,
    GITHUB_STEP_SUMMARY: context.summary,
    INPUT_ARGV: JSON.stringify([
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
    ]),
    INPUT_TASK: "Must not run",
  };
  delete environment.GITHUB_WORKSPACE;
  const result = run(
    context.workspace,
    process.execPath,
    [actionPath],
    environment,
  );

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /\[E_ACTION_ENV\]/u);
  await assert.rejects(access(sentinel), { code: "ENOENT" });
  await assert.rejects(access(context.output), { code: "ENOENT" });
  await assert.rejects(access(context.summary), { code: "ENOENT" });
});
