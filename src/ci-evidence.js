import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isValidTask } from "./contracts.js";
import {
  canonicalJson,
  readRegularFile,
  sha256,
  summarizeFile,
  writeImmutable,
} from "./integrity.js";
import {
  runObservedCommand,
  sealRecorder,
  verifyCapsule,
} from "./handoff.js";
import { initializeRecorder } from "./recorder.js";
import {
  cloneRepositoryCommit,
  repositoryHead,
  repositoryRoot,
  workspaceIsClean,
} from "./workspace.js";

const maximumArgvBytes = 16 * 1024;
const maximumArgvMembers = 128;
const trustedEvidenceEvents = new Set(["push", "workflow_dispatch"]);
const predicateKind = "dev.flight-recorder.ci-verification";
const predicateSchemaVersion = 1;
const actionControlEnvironmentKeys = new Set([
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
]);

export class CIEvidenceError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "CIEvidenceError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const usageError = (code, message) =>
  new CIEvidenceError(code, message, 2);

const portablePath = (path) => path.split(sep).join("/");

const requireEnvironmentValue = (environment, name) => {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0")
  ) {
    throw usageError(
      "E_ACTION_ENV",
      `${name} is required in the GitHub Actions environment.`,
    );
  }
  return value;
};

export const parseArgvInput = (input) => {
  if (typeof input !== "string") {
    throw usageError("E_ACTION_ARGV_JSON", "argv must be a JSON array.");
  }
  if (Buffer.byteLength(input, "utf8") > maximumArgvBytes) {
    throw usageError(
      "E_ACTION_ARGV_SIZE",
      `argv must be ${maximumArgvBytes} UTF-8 bytes or fewer.`,
    );
  }

  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw usageError("E_ACTION_ARGV_JSON", "argv must be valid JSON.");
  }

  if (!Array.isArray(value)) {
    throw usageError("E_ACTION_ARGV_TYPE", "argv must be a JSON array.");
  }
  if (value.length === 0) {
    throw usageError(
      "E_ACTION_ARGV_EMPTY",
      "argv must contain an executable.",
    );
  }
  if (value.length > maximumArgvMembers) {
    throw usageError(
      "E_ACTION_ARGV_COUNT",
      `argv must contain at most ${maximumArgvMembers} strings.`,
    );
  }
  if (value.some((member) => typeof member !== "string")) {
    throw usageError(
      "E_ACTION_ARGV_MEMBER",
      "Every argv member must be a string.",
    );
  }
  if (value[0].length === 0) {
    throw usageError(
      "E_ACTION_ARGV_EXECUTABLE",
      "The argv executable must not be empty.",
    );
  }
  if (value.some((member) => member.includes("\0"))) {
    throw usageError(
      "E_ACTION_ARGV_MEMBER",
      "argv members cannot contain NUL characters.",
    );
  }
  return value;
};

const validateTaskInput = (input) => {
  if (typeof input !== "string" || !isValidTask(input.trim())) {
    throw usageError(
      "E_ACTION_TASK",
      "task must be a non-empty label of 200 characters or fewer.",
    );
  }
  return input;
};

const actionEnvironment = async (environment) => {
  const workspaceArgument = requireEnvironmentValue(
    environment,
    "GITHUB_WORKSPACE",
  );
  const outputPath = requireEnvironmentValue(environment, "GITHUB_OUTPUT");
  const summaryPath = requireEnvironmentValue(
    environment,
    "GITHUB_STEP_SUMMARY",
  );
  const runnerTempArgument = requireEnvironmentValue(
    environment,
    "RUNNER_TEMP",
  );
  const argv = parseArgvInput(environment.INPUT_ARGV);
  const task = validateTaskInput(environment.INPUT_TASK);

  let workspace;
  let runnerTemp;
  let root;
  try {
    workspace = await realpath(workspaceArgument);
    root = await realpath(await repositoryRoot(workspace));
    runnerTemp = await realpath(runnerTempArgument);
  } catch {
    throw usageError(
      "E_ACTION_WORKSPACE",
      "GITHUB_WORKSPACE must be the root of an existing Git checkout.",
    );
  }
  if (workspace !== root) {
    throw usageError(
      "E_ACTION_WORKSPACE",
      "GITHUB_WORKSPACE must be the root of the Git checkout.",
    );
  }

  const eventName = environment.GITHUB_EVENT_NAME ?? "";
  let expectedHead = null;
  if (trustedEvidenceEvents.has(eventName)) {
    expectedHead = requireEnvironmentValue(environment, "GITHUB_SHA");
    if (!/^[a-f0-9]{40,64}$/u.test(expectedHead)) {
      throw usageError(
        "E_ACTION_ENV",
        "GITHUB_SHA must be a supported Git object ID.",
      );
    }
  }

  return {
    argv,
    eventName,
    expectedHead,
    outputPath,
    summaryPath,
    task,
    runnerTemp,
    workspace,
  };
};

const readToolVersion = async () => {
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(metadata.version)
  ) {
    throw new CIEvidenceError(
      "E_ACTION_VERSION",
      "The packaged Flight Recorder version is invalid.",
    );
  }
  return metadata.version;
};

const safeOutputValue = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new CIEvidenceError(
      "E_ACTION_OUTPUT",
      "An Action output was not a safe single-line value.",
    );
  }
  return value;
};

const writeActionFiles = async ({
  outputPath,
  summaryPath,
  values,
}) => {
  const entries = Object.entries(values).map(
    ([name, value]) => `${name}=${safeOutputValue(value)}`,
  );
  const summary = [
    "## Flight Recorder evidence",
    "",
    `- Outcome: \`${values.outcome}\``,
    `- Capsule content digest: \`${values["capsule-content-digest"]}\``,
    `- Capsule file digest: \`${values["capsule-file-digest"]}\``,
    `- Workspace HEAD: \`${values["workspace-head"]}\``,
    "",
    "The command was invoked as an exact argument array with spawn",
    "`shell: false`,",
    "the before/after non-ignored workspace snapshots matched, and the resulting",
    "capsule passed exact verification locally and in a clean clone of HEAD.",
    "",
    "This establishes runner-observed integrity, not test quality, correctness,",
    "authorship, or identity. Git-ignored files are outside the v1 fingerprint.",
    "",
  ].join("\n");

  await appendFile(summaryPath, summary, "utf8");
  await appendFile(outputPath, `${entries.join("\n")}\n`, "utf8");
};

const commandEnvironment = (environment) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !actionControlEnvironmentKeys.has(name.toUpperCase()) &&
        !name.toUpperCase().startsWith("ACTIONS_ID_TOKEN_"),
    ),
  );

const copyVerifiedFile = async ({
  source,
  target,
  expected,
}) => {
  const content = await readRegularFile(source);
  if (
    content.length !== expected.bytes ||
    sha256(content) !== expected.sha256
  ) {
    throw new CIEvidenceError(
      "E_ACTION_EVIDENCE_CHANGED",
      `Evidence changed before clean-clone verification: ${expected.path}.`,
      5,
    );
  }
  await writeImmutable(target, content);
  return content;
};

const verifyInCleanClone = async ({
  capsuleFile,
  expectedHead,
  observed,
  options,
  recorderArgument,
  recorderPath,
  sealed,
}) => {
  const restoreRoot = await mkdtemp(
    join(options.runnerTemp, "flight-recorder-restore-"),
  );
  const clonePath = join(restoreRoot, "checkout");
  const targetRecorder = resolve(clonePath, ...recorderArgument.split("/"));
  const receiptRelative = portablePath(
    relative(recorderPath, observed.receiptPath),
  );
  const capsuleRelative = portablePath(
    relative(recorderPath, sealed.capsulePath),
  );

  try {
    if (
      sealed.capsule.receipts.length !== 1 ||
      sealed.capsule.receipts[0].path !== receiptRelative
    ) {
      throw new CIEvidenceError(
        "E_ACTION_EVIDENCE_EXTRA",
        "The Action recorder must contain exactly its one observed receipt.",
        5,
      );
    }
    await cloneRepositoryCommit({
      source: options.workspace,
      target: clonePath,
      head: expectedHead,
    });
    for (const artifact of sealed.capsule.artifacts) {
      await copyVerifiedFile({
        source: resolve(recorderPath, ...artifact.path.split("/")),
        target: resolve(targetRecorder, ...artifact.path.split("/")),
        expected: artifact,
      });
    }
    await copyVerifiedFile({
      source: observed.receiptPath,
      target: resolve(targetRecorder, ...receiptRelative.split("/")),
      expected: sealed.capsule.receipts[0],
    });
    await copyVerifiedFile({
      source: sealed.capsulePath,
      target: resolve(targetRecorder, ...capsuleRelative.split("/")),
      expected: capsuleFile,
    });

    const restored = await verifyCapsule({
      cwd: clonePath,
      capsuleArgument: portablePath(
        join(recorderArgument, capsuleRelative),
      ),
    });
    if (restored.name !== "VALID" || restored.exitCode !== 0) {
      throw new CIEvidenceError(
        "E_ACTION_CLEAN_CLONE",
        `The capsule did not verify in a clean clone of ${expectedHead}.`,
        4,
      );
    }
  } finally {
    await rm(restoreRoot, { recursive: true, force: true });
  }
};

const createAttestationBundle = async ({
  capsuleFile,
  capsulePath,
  options,
  predicateText,
}) => {
  const bundlePath = await mkdtemp(
    join(options.runnerTemp, "flight-recorder-attestation-"),
  );
  const attestationCapsulePath = resolve(bundlePath, "capsule.json");
  const attestationPredicatePath = resolve(bundlePath, "predicate.json");
  await copyVerifiedFile({
    source: capsulePath,
    target: attestationCapsulePath,
    expected: capsuleFile,
  });
  await writeImmutable(attestationPredicatePath, predicateText);
  return {
    bundlePath,
    capsulePath: attestationCapsulePath,
    predicatePath: attestationPredicatePath,
  };
};

export const createCIEvidence = async ({ environment }) => {
  const options = await actionEnvironment(environment);
  const recorderArgument = portablePath(
    join(".flight-recorder", `evidence-${randomUUID()}`),
  );
  if (
    options.expectedHead !== null &&
    (await repositoryHead(options.workspace)) !== options.expectedHead
  ) {
    throw new CIEvidenceError(
      "E_ACTION_HEAD_MISMATCH",
      "The workspace HEAD does not match GITHUB_SHA; no command was executed.",
      4,
    );
  }
  if (!(await workspaceIsClean({ repoRoot: options.workspace }))) {
    throw new CIEvidenceError(
      "E_ACTION_WORKSPACE_DIRTY",
      "The non-ignored Git workspace must be clean; no command was executed.",
      4,
    );
  }

  const initialized = await initializeRecorder({
    cwd: options.workspace,
    directory: recorderArgument,
    task: options.task,
  });
  const recorderPath = initialized.target;

  const observed = await runObservedCommand({
    cwd: options.workspace,
    recorderArgument,
    argv: options.argv,
    childEnvironment: commandEnvironment(environment),
  });
  if (observed.processExitCode !== 0) {
    throw new CIEvidenceError(
      "E_ACTION_COMMAND",
      `Observed command exited with status ${observed.processExitCode}.`,
      observed.processExitCode,
    );
  }
  if (
    canonicalJson(observed.receipt.workspaceBefore) !==
    canonicalJson(observed.receipt.workspaceAfter)
  ) {
    throw new CIEvidenceError(
      "E_ACTION_WORKSPACE_MUTATED",
      "The non-ignored workspace snapshots differ before and after the command.",
      4,
    );
  }
  if (
    !(await workspaceIsClean({
      repoRoot: options.workspace,
      excludedRecorderPath: recorderArgument,
    }))
  ) {
    throw new CIEvidenceError(
      "E_ACTION_WORKSPACE_DIRTY",
      "The non-ignored Git workspace is not clean after command execution.",
      4,
    );
  }
  if (
    options.expectedHead !== null &&
    observed.receipt.workspaceAfter.head !== options.expectedHead
  ) {
    throw new CIEvidenceError(
      "E_ACTION_HEAD_MISMATCH",
      "The observed workspace HEAD no longer matches GITHUB_SHA.",
      4,
    );
  }

  const sealed = await sealRecorder({
    cwd: options.workspace,
    recorderArgument,
  });
  const verified = await verifyCapsule({
    cwd: options.workspace,
    capsuleArgument: portablePath(
      relative(options.workspace, sealed.capsulePath),
    ),
  });
  if (verified.name !== "VALID" || verified.exitCode !== 0) {
    throw new CIEvidenceError(
      "E_ACTION_VERIFY",
      `The generated capsule failed exact verification with ${verified.name}.`,
      verified.exitCode,
    );
  }

  const [toolVersion, capsuleFile, receiptFile] = await Promise.all([
    readToolVersion(),
    summarizeFile(sealed.capsulePath, "capsule"),
    summarizeFile(observed.receiptPath, "receipt"),
  ]);
  await verifyInCleanClone({
    capsuleFile,
    expectedHead: observed.receipt.workspaceAfter.head,
    observed,
    options,
    recorderArgument,
    recorderPath,
    sealed,
  });
  const capsuleContentDigest = sealed.capsule.contentDigest;
  const capsuleFileDigest = `sha256:${capsuleFile.sha256}`;
  const predicate = {
    schemaVersion: predicateSchemaVersion,
    kind: predicateKind,
    outcome: "VALID",
    tool: {
      name: "@techbantu/flight-recorder",
      version: toolVersion,
    },
    capsuleContentDigest,
    capsuleFileDigest,
    workspaceHead: observed.receipt.workspaceAfter.head,
    workspaceFingerprintDigest: `sha256:${sha256(
      canonicalJson(observed.receipt.workspaceAfter),
    )}`,
    commandArgvDigest: `sha256:${sha256(
      canonicalJson(observed.receipt.command.argv),
    )}`,
    receiptFileDigest: `sha256:${receiptFile.sha256}`,
    policy: {
      cleanCloneVerified: true,
      spawnShell: false,
      workspaceSnapshotsMatched: true,
    },
  };
  const predicatePath = resolve(recorderPath, "ci-verification-v1.json");
  const predicateText = `${JSON.stringify(predicate, null, 2)}\n`;
  const predicateFileDigest = `sha256:${sha256(
    Buffer.from(predicateText, "utf8"),
  )}`;
  await writeImmutable(predicatePath, predicateText);
  const attestation = await createAttestationBundle({
    capsuleFile,
    capsulePath: sealed.capsulePath,
    options,
    predicateText,
  });

  const values = {
    outcome: verified.name,
    "recorder-path": recorderPath,
    "receipt-path": observed.receiptPath,
    "capsule-path": sealed.capsulePath,
    "predicate-path": predicatePath,
    "attestation-bundle-path": attestation.bundlePath,
    "attestation-capsule-path": attestation.capsulePath,
    "attestation-predicate-path": attestation.predicatePath,
    "capsule-content-digest": capsuleContentDigest,
    "capsule-file-digest": capsuleFileDigest,
    "predicate-file-digest": predicateFileDigest,
    "workspace-head": observed.receipt.workspaceAfter.head,
  };
  await writeActionFiles({
    outputPath: options.outputPath,
    summaryPath: options.summaryPath,
    values,
  });
  return { predicate, values };
};
