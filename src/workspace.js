import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { summarizeFile } from "./integrity.js";

const execute = promisify(execFile);
const gitOutputLimit = 128 * 1024 * 1024;

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

const toPortablePath = (path) => path.split(sep).join("/");

const boundaryFrom = (root, target) => {
  const boundary = relative(root, target);
  const outside =
    boundary === ".." ||
    boundary.startsWith(`..${sep}`) ||
    isAbsolute(boundary);
  if (outside) {
    throw new WorkspaceError(
      "E_PATH_OUTSIDE",
      "Path must resolve inside the current working directory.",
    );
  }
  return boundary;
};

const inspect = async (path) =>
  lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

const assertExistingPath = async (root, target, expectedKind) => {
  const boundary = boundaryFrom(root, target);
  const segments = boundary ? boundary.split(sep) : [];
  let current = root;

  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const status = await inspect(current);
    if (status === null) {
      throw new WorkspaceError("E_PATH_MISSING", `Path does not exist: ${current}`);
    }
    if (status.isSymbolicLink()) {
      throw new WorkspaceError(
        "E_PATH_SYMLINK",
        "Recorder and capsule paths cannot traverse symbolic links.",
      );
    }
    if (index < segments.length - 1 && !status.isDirectory()) {
      throw new WorkspaceError(
        "E_PATH_TYPE",
        `Path ancestor is not a directory: ${current}`,
      );
    }
  }

  const status = await inspect(target);
  const matches =
    expectedKind === "directory" ? status?.isDirectory() : status?.isFile();
  if (!matches) {
    throw new WorkspaceError(
      "E_PATH_TYPE",
      `${target} must be a ${expectedKind}.`,
    );
  }
};

const runGit = async (cwd, arguments_, encoding = "utf8") => {
  try {
    const { stdout } = await execute("git", arguments_, {
      cwd,
      encoding,
      maxBuffer: gitOutputLimit,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new WorkspaceError(
      "E_GIT",
      `Git command failed: ${arguments_.slice(0, 2).join(" ")}.`,
    );
  }
};

export const repositoryRoot = async (cwd) => {
  const root = (
    await runGit(cwd, ["rev-parse", "--show-toplevel"])
  ).replace(/\r?\n$/u, "");
  if (!root) {
    throw new WorkspaceError("E_GIT_ROOT", "A Git working tree is required.");
  }
  return realpath(root);
};

const validateState = (value) => {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value);
  return (
    record &&
    value.schemaVersion === 1 &&
    typeof value.project === "string" &&
    typeof value.mode === "string" &&
    typeof value.activeTask === "string" &&
    value.activeTask.length > 0 &&
    value.ids !== null &&
    typeof value.ids === "object" &&
    !Array.isArray(value.ids) &&
    (value.lastUpdated === null || typeof value.lastUpdated === "string")
  );
};

export const loadRecorder = async (cwd, argument) => {
  if (typeof argument !== "string" || !argument.trim()) {
    throw new WorkspaceError("E_RECORDER_PATH", "Provide a recorder directory.");
  }
  if (/[\u0000-\u001f\u007f]/u.test(argument)) {
    throw new WorkspaceError(
      "E_RECORDER_PATH",
      "Recorder paths cannot contain control characters.",
    );
  }

  const workingRoot = await realpath(cwd);
  const recorder = resolve(workingRoot, argument);
  await assertExistingPath(workingRoot, recorder, "directory");

  const statePath = resolve(recorder, "state.json");
  await assertExistingPath(workingRoot, statePath, "file");
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    throw new WorkspaceError(
      "E_STATE_INVALID",
      "Recorder state.json is not valid JSON.",
    );
  }
  if (!validateState(state)) {
    throw new WorkspaceError(
      "E_STATE_SCHEMA",
      "Recorder state.json is not Flight Recorder schema 1.",
    );
  }

  const repoRoot = await repositoryRoot(recorder);
  const repoBoundary = boundaryFrom(repoRoot, recorder);
  const cwdBoundary = boundaryFrom(repoRoot, workingRoot);
  if (!repoBoundary) {
    throw new WorkspaceError(
      "E_RECORDER_ROOT",
      "The recorder cannot be the Git repository root.",
    );
  }

  return {
    cwd: workingRoot,
    path: recorder,
    relativePath: toPortablePath(repoBoundary),
    repoRoot,
    cwdRelativePath: toPortablePath(cwdBoundary) || ".",
    state,
  };
};

export const loadCapsulePath = async (cwd, argument) => {
  if (typeof argument !== "string" || !argument.trim()) {
    throw new WorkspaceError("E_CAPSULE_PATH", "Provide a capsule path.");
  }
  const workingRoot = await realpath(cwd);
  const capsule = resolve(workingRoot, argument);
  await assertExistingPath(workingRoot, capsule, "file");
  return { path: capsule, workingRoot };
};

const digestBuffer = (buffer) => ({
  bytes: buffer.length,
  sha256: createHash("sha256").update(buffer).digest("hex"),
});

const untrackedPaths = (buffer) =>
  buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

export const fingerprintWorkspace = async ({
  repoRoot,
  recorderRelativePath,
}) => {
  const exclusion = `:(exclude,literal)${recorderRelativePath}`;
  const commonDiff = [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-renames",
    "--full-index",
    "--ignore-submodules=none",
  ];
  const [head, staged, unstaged, untrackedRaw, submodules] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]),
    runGit(
      repoRoot,
      [...commonDiff, "--cached", "--", ".", exclusion],
      "buffer",
    ),
    runGit(repoRoot, [...commonDiff, "--", ".", exclusion], "buffer"),
    runGit(
      repoRoot,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      "buffer",
    ),
    runGit(repoRoot, ["submodule", "status", "--recursive"]),
  ]);

  const relevantUntracked = untrackedPaths(untrackedRaw).filter(
    (path) =>
      path !== recorderRelativePath &&
      !path.startsWith(`${recorderRelativePath}/`),
  );
  const untracked = [];
  for (const path of relevantUntracked) {
    const absolute = resolve(repoRoot, path);
    boundaryFrom(repoRoot, absolute);
    const status = await lstat(absolute);
    if (status.isSymbolicLink()) {
      throw new WorkspaceError(
        "E_WORKSPACE_SYMLINK",
        `Cannot fingerprint untracked symbolic link: ${path}`,
      );
    }
    if (!status.isFile()) {
      throw new WorkspaceError(
        "E_WORKSPACE_TYPE",
        `Cannot fingerprint non-file workspace entry: ${path}`,
      );
    }
    untracked.push(await summarizeFile(absolute, toPortablePath(path)));
  }

  const submoduleBuffer = Buffer.from(submodules, "utf8");
  return {
    version: 1,
    vcs: "git",
    head: head.trim(),
    excludedRecorderPath: recorderRelativePath,
    staged: digestBuffer(staged),
    unstaged: digestBuffer(unstaged),
    untracked,
    submodules: digestBuffer(submoduleBuffer),
  };
};

export const assertSafeFile = async (root, path) =>
  assertExistingPath(root, path, "file");

export const assertSafeDirectory = async (root, path) =>
  assertExistingPath(root, path, "directory");
