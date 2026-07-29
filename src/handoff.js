import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  canonicalJson,
  sha256,
  summarizeFile,
  writeImmutable,
} from "./integrity.js";
import {
  assertSafeDirectory,
  assertSafeFile,
  fingerprintWorkspace,
  loadCapsulePath,
  loadRecorder,
  repositoryRoot,
} from "./workspace.js";

const artifactPaths = [
  "state.json",
  "decisions.log",
  "checks.md",
  "resume.md",
];
const capsuleKind = "dev.flight-recorder.handoff";
const receiptKind = "dev.flight-recorder.command-receipt";
const schemaVersion = 1;

export class HandoffError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const portablePath = (path) => path.split(sep).join("/");

const outputObserver = (stream, destination) => {
  const digest = createHash("sha256");
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    digest.update(chunk);
  });
  stream.pipe(destination, { end: false });
  return () => ({ bytes, sha256: digest.digest("hex") });
};

const processResult = (child, timeoutMs) =>
  new Promise((resolveResult) => {
    let spawnErrorCode = null;
    let timedOut = false;
    let forceTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      spawnErrorCode = error.code ?? "E_SPAWN";
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      resolveResult({ exitCode, signal, spawnErrorCode, timedOut });
    });
  });

const ensureSafeChildDirectory = async (recorder, name) => {
  const path = resolve(recorder.path, name);
  const status = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (status?.isSymbolicLink() || (status && !status.isDirectory())) {
    throw new HandoffError(
      "E_PATH_TYPE",
      `${name} must be a real directory inside the recorder.`,
    );
  }
  if (!status) await mkdir(path);
  await assertSafeDirectory(recorder.path, path);
  return path;
};

export const runObservedCommand = async ({
  cwd,
  recorderArgument,
  argv,
  timeoutMs = 300_000,
}) => {
  if (!Array.isArray(argv) || argv.length === 0 || !argv[0]) {
    throw new HandoffError("E_COMMAND_EMPTY", "Provide a command after --.", 2);
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000
  ) {
    throw new HandoffError(
      "E_TIMEOUT",
      "Timeout must be an integer from 1 to 3600000 milliseconds.",
      2,
    );
  }

  const recorder = await loadRecorder(cwd, recorderArgument);
  const receiptsDirectory = await ensureSafeChildDirectory(recorder, "receipts");
  const workspaceBefore = await fingerprintWorkspace({
    repoRoot: recorder.repoRoot,
    recorderRelativePath: recorder.relativePath,
  });
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: recorder.cwd,
    env: process.env,
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = outputObserver(child.stdout, process.stdout);
  const stderr = outputObserver(child.stderr, process.stderr);
  const result = await processResult(child, timeoutMs);
  const completedAt = new Date().toISOString();
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const workspaceAfter = await fingerprintWorkspace({
    repoRoot: recorder.repoRoot,
    recorderRelativePath: recorder.relativePath,
  });
  const id = randomUUID();
  const receipt = {
    schemaVersion,
    kind: receiptKind,
    id,
    observation: "observed-by-flight-recorder",
    task: recorder.state.activeTask,
    command: {
      argv,
      cwd: recorder.cwdRelativePath,
    },
    startedAt,
    completedAt,
    durationMs,
    result: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      spawnErrorCode: result.spawnErrorCode,
      stdout: stdout(),
      stderr: stderr(),
    },
    workspaceBefore,
    workspaceAfter,
  };
  const receiptName = `receipt-${id}.json`;
  const receiptPath = resolve(receiptsDirectory, receiptName);
  await writeImmutable(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const processExitCode = result.timedOut
    ? 124
    : result.spawnErrorCode === "ENOENT"
      ? 127
      : Number.isInteger(result.exitCode) &&
          result.exitCode >= 0 &&
          result.exitCode <= 255
        ? result.exitCode
        : 1;
  return {
    processExitCode,
    receipt,
    receiptPath,
    displayPath: portablePath(relative(recorder.cwd, receiptPath)),
  };
};

const listFiles = async (root, directory, prefix) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = resolve(directory, entry.name);
    const displayPath = portablePath(join(prefix, entry.name));
    if (entry.isSymbolicLink()) {
      throw new HandoffError(
        "E_PATH_SYMLINK",
        `Receipt paths cannot traverse symbolic links: ${displayPath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path, displayPath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new HandoffError(
        "E_PATH_TYPE",
        `Receipt must be a regular file: ${displayPath}`,
      );
    }
    await assertSafeFile(root, path);
    files.push(await summarizeFile(path, displayPath));
  }
  return files;
};

const summarizeArtifacts = async (recorder) => {
  const artifacts = [];
  for (const path of artifactPaths) {
    const absolute = resolve(recorder.path, path);
    await assertSafeFile(recorder.path, absolute);
    artifacts.push(await summarizeFile(absolute, path));
  }
  const receiptsDirectory = await ensureSafeChildDirectory(recorder, "receipts");
  return {
    artifacts,
    receipts: await listFiles(recorder.path, receiptsDirectory, "receipts"),
  };
};

export const sealRecorder = async ({ cwd, recorderArgument }) => {
  const recorder = await loadRecorder(cwd, recorderArgument);
  const { artifacts, receipts } = await summarizeArtifacts(recorder);
  const workspace = await fingerprintWorkspace({
    repoRoot: recorder.repoRoot,
    recorderRelativePath: recorder.relativePath,
  });
  const unsigned = {
    schemaVersion,
    kind: capsuleKind,
    recorder: {
      path: recorder.relativePath,
      task: recorder.state.activeTask,
    },
    workspace,
    artifacts,
    receipts,
  };
  const digest = sha256(canonicalJson(unsigned));
  const capsule = {
    ...unsigned,
    contentDigest: `sha256:${digest}`,
  };
  const capsulesDirectory = await ensureSafeChildDirectory(recorder, "capsules");
  const capsulePath = resolve(capsulesDirectory, `sha256-${digest}.json`);
  await writeImmutable(capsulePath, `${JSON.stringify(capsule, null, 2)}\n`);

  return {
    capsule,
    capsulePath,
    displayPath: portablePath(relative(recorder.cwd, capsulePath)),
  };
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const safePortableRelativePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== "..");

const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const validDigest = (value) =>
  hasExactKeys(value, ["bytes", "sha256"]) &&
  Number.isSafeInteger(value.bytes) &&
  value.bytes >= 0 &&
  typeof value.sha256 === "string" &&
  /^[a-f0-9]{64}$/u.test(value.sha256);

const validSummary = (value) =>
  hasExactKeys(value, ["path", "bytes", "sha256"]) &&
  safePortableRelativePath(value.path) &&
  Number.isSafeInteger(value.bytes) &&
  value.bytes >= 0 &&
  typeof value.sha256 === "string" &&
  /^[a-f0-9]{64}$/u.test(value.sha256);

const validWorkspace = (value) =>
  hasExactKeys(value, [
    "version",
    "vcs",
    "head",
    "excludedRecorderPath",
    "staged",
    "unstaged",
    "untracked",
    "submodules",
  ]) &&
  value.version === 1 &&
  value.vcs === "git" &&
  typeof value.head === "string" &&
  /^[a-f0-9]{40,64}$/u.test(value.head) &&
  safePortableRelativePath(value.excludedRecorderPath) &&
  validDigest(value.staged) &&
  validDigest(value.unstaged) &&
  Array.isArray(value.untracked) &&
  value.untracked.every(validSummary) &&
  validDigest(value.submodules);

const validateCapsule = (capsule) => {
  if (
    !hasExactKeys(capsule, [
      "schemaVersion",
      "kind",
      "recorder",
      "workspace",
      "artifacts",
      "receipts",
      "contentDigest",
    ])
  ) {
    return false;
  }
  if (capsule.schemaVersion !== schemaVersion || capsule.kind !== capsuleKind) {
    return false;
  }
  if (!Array.isArray(capsule.artifacts) || !Array.isArray(capsule.receipts)) {
    return false;
  }
  const artifactNames = capsule.artifacts.map(({ path }) => path);
  const receiptNames = capsule.receipts.map(({ path }) => path);
  return (
    hasExactKeys(capsule.recorder, ["path", "task"]) &&
    safePortableRelativePath(capsule.recorder.path) &&
    typeof capsule.recorder.task === "string" &&
    capsule.recorder.task.length > 0 &&
    validWorkspace(capsule.workspace) &&
    capsule.artifacts.every(validSummary) &&
    canonicalJson(artifactNames) === canonicalJson(artifactPaths) &&
    capsule.receipts.every(validSummary) &&
    receiptNames.every((path) => path.startsWith("receipts/")) &&
    new Set(receiptNames).size === receiptNames.length &&
    capsule.workspace.excludedRecorderPath === capsule.recorder.path &&
    typeof capsule.contentDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(capsule.contentDigest)
  );
};

const untamperedSummaries = async (recorder, summaries) => {
  for (const summary of summaries) {
    const absolute = resolve(recorder.path, summary.path);
    try {
      await assertSafeFile(recorder.path, absolute);
      const current = await summarizeFile(absolute, summary.path);
      if (canonicalJson(current) !== canonicalJson(summary)) return false;
    } catch {
      return false;
    }
  }
  return true;
};

const receiptSupportsWorkspace = async (recorder, summary, workspace) => {
  if (!summary.path.endsWith(".json")) return false;
  try {
    const receipt = JSON.parse(
      await readFile(resolve(recorder.path, summary.path), "utf8"),
    );
    return (
      isRecord(receipt) &&
      receipt.schemaVersion === schemaVersion &&
      receipt.kind === receiptKind &&
      receipt.observation === "observed-by-flight-recorder" &&
      isRecord(receipt.result) &&
      receipt.result.exitCode === 0 &&
      canonicalJson(receipt.workspaceAfter) === canonicalJson(workspace)
    );
  } catch {
    return false;
  }
};

const outcome = (name, detail, exitCode) => ({ name, detail, exitCode });

export const verifyCapsule = async ({ cwd, capsuleArgument }) => {
  let capsulePath;
  let capsule;
  try {
    ({ path: capsulePath } = await loadCapsulePath(cwd, capsuleArgument));
    capsule = JSON.parse(await readFile(capsulePath, "utf8"));
  } catch (error) {
    return outcome(
      "INVALID",
      `[${error.code ?? "E_CAPSULE_INVALID"}] Capsule is not valid JSON or is unsafe.`,
      6,
    );
  }

  if (!validateCapsule(capsule)) {
    return outcome("INVALID", "[E_CAPSULE_SCHEMA] Unsupported capsule schema.", 6);
  }

  const { contentDigest, ...unsigned } = capsule;
  const digest = sha256(canonicalJson(unsigned));
  const addressedName = `sha256-${digest}.json`;
  if (
    contentDigest !== `sha256:${digest}` ||
    basename(capsulePath) !== addressedName
  ) {
    return outcome(
      "TAMPERED",
      "[E_CAPSULE_DIGEST] Capsule content does not match its address.",
      5,
    );
  }

  let recorder;
  try {
    const repoRoot = await repositoryRoot(cwd);
    recorder = await loadRecorder(repoRoot, capsule.recorder.path);
  } catch (error) {
    return outcome(
      "INVALID",
      `[${error.code ?? "E_RECORDER_INVALID"}] Recorder path is invalid.`,
      6,
    );
  }
  if (recorder.state.activeTask !== capsule.recorder.task) {
    return outcome(
      "TAMPERED",
      "[E_TASK_MISMATCH] Recorder task no longer matches the capsule.",
      5,
    );
  }

  if (
    !(await untamperedSummaries(recorder, [
      ...capsule.artifacts,
      ...capsule.receipts,
    ]))
  ) {
    return outcome(
      "TAMPERED",
      "[E_ARTIFACT_DIGEST] A sealed artifact or receipt changed.",
      5,
    );
  }

  let currentWorkspace;
  try {
    currentWorkspace = await fingerprintWorkspace({
      repoRoot: recorder.repoRoot,
      recorderRelativePath: recorder.relativePath,
    });
  } catch (error) {
    return outcome(
      "INVALID",
      `[${error.code ?? "E_WORKSPACE"}] Workspace cannot be fingerprinted safely.`,
      6,
    );
  }
  if (canonicalJson(currentWorkspace) !== canonicalJson(capsule.workspace)) {
    return outcome(
      "STALE_WORKSPACE",
      "[E_WORKSPACE_STALE] Git workspace differs from the sealed state.",
      4,
    );
  }

  const observations = await Promise.all(
    capsule.receipts.map((summary) =>
      receiptSupportsWorkspace(recorder, summary, capsule.workspace),
    ),
  );
  if (!observations.some(Boolean)) {
    return outcome(
      "UNVERIFIED",
      "[E_PROOF_MISSING] No successful observed command matches this workspace.",
      3,
    );
  }

  return outcome(
    "VALID",
    `sha256:${digest} matches the current Git workspace.`,
    0,
  );
};

export const invalidOutcome = (error) =>
  outcome(
    "INVALID",
    `[${error.code ?? "E_IO"}] ${error.message ?? "Operation failed."}`,
    6,
  );
