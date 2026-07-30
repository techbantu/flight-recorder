import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  compareCodeUnits,
  isPortableRelativePath,
  isValidTask,
} from "./contracts.js";
import { canonicalJson, summarizeFile } from "./integrity.js";

const execute = promisify(execFile);
const gitOutputLimit = 128 * 1024 * 1024;
const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const stableCaptureLimit = 4;
const inertGitArguments = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  `core.hooksPath=${nullDevice}`,
];

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

const gitEnvironmentKeys = new Set([
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

const cleanGitEnvironment = () => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && gitEnvironmentKeys.has(key.toUpperCase()),
    ),
  );
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "C",
    LC_ALL: "C",
  };
};

const executableFilterKey =
  /^filter\..+\.(?:clean|smudge|process)$/iu;

const gitlinkPaths = (buffer, context) => {
  const paths = [];
  for (const entry of decodeGit(buffer, context).split("\0").filter(Boolean)) {
    const match = entry.match(
      /^([0-7]{6}) [a-f0-9]{40,64} [0-3]\t([\s\S]+)$/u,
    );
    if (!match || !isPortableRelativePath(match[2])) {
      throw new WorkspaceError(
        "E_WORKSPACE_INDEX",
        "Git index contains an unsupported or non-portable entry.",
      );
    }
    if (match[1] === "160000") paths.push(match[2]);
  }
  return [...new Set(paths)].sort(compareCodeUnits);
};

const assertSafeGitStatusConfiguration = async (repoRoot) => {
  const canonicalRoot = await realpath(repoRoot);

  const configuredKeys = decodeGit(
    await runGit(canonicalRoot, [
      "config",
      "--null",
      "--name-only",
      "--list",
    ]),
    "Git configuration",
  )
    .split("\0")
    .filter(Boolean);
  if (configuredKeys.some((key) => executableFilterKey.test(key))) {
    throw new WorkspaceError(
      "E_GIT_FILTER",
      "Executable Git content filters are unsupported; the observed command was not executed.",
    );
  }

  const index = await runGit(canonicalRoot, [
    "ls-files",
    "--stage",
    "-z",
    "--",
  ]);
  for (const path of gitlinkPaths(index, "Git submodule index")) {
    const absolute = await safeWorkspaceTarget(canonicalRoot, path);
    const status = await inspect(absolute);
    if (!status) continue;
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new WorkspaceError(
        "E_SUBMODULE_TYPE",
        `Submodule checkout must be a real directory: ${path}`,
      );
    }
    const dotGit = await inspect(resolve(absolute, ".git"));
    if (!dotGit) continue;
    if (dotGit.isSymbolicLink() || (!dotGit.isFile() && !dotGit.isDirectory())) {
      throw new WorkspaceError(
        "E_SUBMODULE_GITDIR",
        `Submodule metadata path is unsafe: ${path}`,
      );
    }
    throw new WorkspaceError(
      "E_SUBMODULE_INITIALIZED",
      "Initialized submodules are unsupported by the Action clean-clone policy; the observed command was not executed.",
    );
  }
};

const runGit = async (cwd, arguments_) => {
  try {
    const { stdout } = await execute(
      "git",
      [...inertGitArguments, ...arguments_],
      {
        cwd,
        encoding: "buffer",
        env: cleanGitEnvironment(),
        maxBuffer: gitOutputLimit,
        windowsHide: true,
      },
    );
    return stdout;
  } catch (error) {
    throw new WorkspaceError(
      "E_GIT",
      `Inert Git metadata command failed: ${arguments_.slice(0, 2).join(" ")}.`,
    );
  }
};

const decodeGit = (buffer, context) => {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    throw new WorkspaceError(
      "E_WORKSPACE_PATH_ENCODING",
      `${context} contains a path that is not valid UTF-8.`,
    );
  }
};

export const repositoryRoot = async (cwd) => {
  const root = decodeGit(
    await runGit(cwd, ["rev-parse", "--show-toplevel"]),
    "Git repository root",
  ).replace(/\r?\n$/u, "");
  if (!root) {
    throw new WorkspaceError("E_GIT_ROOT", "A Git working tree is required.");
  }
  return realpath(root);
};

export const repositoryHead = async (cwd) => {
  const head = decodeGit(
    await runGit(cwd, ["rev-parse", "--verify", "HEAD"]),
    "Git HEAD",
  ).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(head)) {
    throw new WorkspaceError("E_GIT_HEAD", "Git HEAD is not a supported object ID.");
  }
  return head;
};

export const cloneRepositoryCommit = async ({
  source,
  target,
  head,
}) => {
  await runGit(source, [
    "clone",
    "--quiet",
    "--no-local",
    "--no-checkout",
    "--",
    source,
    target,
  ]);
  await runGit(target, [
    "checkout",
    "--quiet",
    "--detach",
    head,
    "--",
  ]);
  if ((await repositoryHead(target)) !== head) {
    throw new WorkspaceError(
      "E_GIT_HEAD",
      "The clean clone did not check out the expected Git HEAD.",
    );
  }
};

export const workspaceIsClean = async ({
  repoRoot,
  excludedRecorderPath = null,
}) => {
  if (
    excludedRecorderPath !== null &&
    !isPortableRelativePath(excludedRecorderPath)
  ) {
    throw new WorkspaceError(
      "E_RECORDER_PATH_PORTABLE",
      "Recorder path must use the portable path contract.",
    );
  }
  await assertSafeGitStatusConfiguration(repoRoot);
  const platformTracksModesAndSymlinks = process.platform !== "win32";
  const [statusRaw, indexFlagsRaw] = await Promise.all([
    runGit(repoRoot, [
      "-c",
      "core.excludesFile=",
      "-c",
      `core.fileMode=${platformTracksModesAndSymlinks}`,
      "-c",
      `core.symlinks=${platformTracksModesAndSymlinks}`,
      "-c",
      "core.ignoreCase=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--no-renames",
      "-z",
      "--",
    ]),
    runGit(repoRoot, ["ls-files", "-v", "-z", "--"]),
  ]);
  const concealedIndexEntry = decodeGit(
    indexFlagsRaw,
    "Git index flags",
  )
    .split("\0")
    .filter(Boolean)
    .some((entry) => {
      const tag = entry[0];
      return tag === "S" || tag !== tag.toUpperCase();
    });
  if (concealedIndexEntry) return false;
  const status = decodeGit(statusRaw, "Git status");
  const entries = status.split("\0").filter(Boolean);
  return entries.every((entry) => {
    if (entry.length < 4 || entry[2] !== " ") return false;
    const path = entry.slice(3);
    return (
      excludedRecorderPath !== null &&
      (path === excludedRecorderPath ||
        path.startsWith(`${excludedRecorderPath}/`))
    );
  });
};

const validateState = (value) => {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value);
  return (
    record &&
    value.schemaVersion === 1 &&
    typeof value.project === "string" &&
    typeof value.mode === "string" &&
    isValidTask(value.activeTask) &&
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
  const relativePath = toPortablePath(repoBoundary);
  const cwdRelativePath = toPortablePath(cwdBoundary) || ".";
  if (
    !isPortableRelativePath(relativePath) ||
    (cwdRelativePath !== "." && !isPortableRelativePath(cwdRelativePath))
  ) {
    throw new WorkspaceError(
      "E_RECORDER_PATH_PORTABLE",
      "Recorder and working paths must use the portable path contract.",
    );
  }

  return {
    cwd: workingRoot,
    path: recorder,
    relativePath,
    repoRoot,
    cwdRelativePath,
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

const digestCanonical = (value) =>
  digestBuffer(Buffer.from(canonicalJson(value), "utf8"));

const parseIndex = (buffer, recorderRelativePath) => {
  const records = decodeGit(buffer, "Git index")
    .split("\0")
    .filter(Boolean);
  const entries = records.map((record) => {
    const match = record.match(
      /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/u,
    );
    if (!match || !isPortableRelativePath(match[4])) {
      throw new WorkspaceError(
        "E_WORKSPACE_INDEX",
        "Git index contains an unsupported or non-portable entry.",
      );
    }
    return {
      mode: match[1],
      objectId: match[2],
      stage: Number(match[3]),
      path: match[4],
    };
  });
  return entries
    .filter(
      ({ path }) =>
        path !== recorderRelativePath &&
        !path.startsWith(`${recorderRelativePath}/`),
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.path, right.path) ||
        left.stage - right.stage ||
        compareCodeUnits(left.mode, right.mode) ||
        compareCodeUnits(left.objectId, right.objectId),
    );
};

const parseUntracked = (buffer, recorderRelativePath) =>
  decodeGit(buffer, "Git untracked-file list")
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      if (!isPortableRelativePath(path)) {
        throw new WorkspaceError(
          "E_WORKSPACE_PATH",
          "Git reported a non-portable untracked path.",
        );
      }
      return path;
    })
    .filter(
      (path) =>
        path !== recorderRelativePath &&
        !path.startsWith(`${recorderRelativePath}/`),
    )
    .sort(compareCodeUnits);

const safeWorkspaceTarget = async (repoRoot, portablePath) => {
  if (!isPortableRelativePath(portablePath)) {
    throw new WorkspaceError(
      "E_WORKSPACE_PATH",
      "Workspace paths must use the portable path contract.",
    );
  }
  const segments = portablePath.split("/");
  let current = repoRoot;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const status = await inspect(current);
    if (status?.isSymbolicLink() || (status && !status.isDirectory())) {
      throw new WorkspaceError(
        "E_WORKSPACE_ANCESTOR",
        `Workspace path has an unsafe ancestor: ${portablePath}`,
      );
    }
    if (!status) break;
  }
  const target = resolve(repoRoot, ...segments);
  boundaryFrom(repoRoot, target);
  return target;
};

const regularMode = (status) =>
  process.platform === "win32" || (status.mode & 0o111) === 0
    ? "100644"
    : "100755";

const fileIdentity = (status) =>
  [
    status.dev,
    status.ino,
    status.mode,
    status.size,
    status.mtimeNs,
    status.ctimeNs,
  ].join(":");

const stableFileSummary = async (absolute, path) => {
  const before = await lstat(absolute, { bigint: true });
  const summary = await summarizeFile(absolute, path);
  const after = await lstat(absolute, { bigint: true });
  if (fileIdentity(before) !== fileIdentity(after)) {
    throw new WorkspaceError(
      "E_WORKSPACE_UNSTABLE",
      `Workspace file changed while it was being fingerprinted: ${path}`,
    );
  }
  return summary;
};

const trackedWorktreeEntry = async (repoRoot, path) => {
  const absolute = await safeWorkspaceTarget(repoRoot, path);
  const status = await inspect(absolute);
  if (!status) return { path, kind: "missing" };
  if (status.isSymbolicLink()) {
    const before = await lstat(absolute, { bigint: true });
    const target = await readlink(absolute, { encoding: "buffer" });
    const after = await lstat(absolute, { bigint: true });
    if (fileIdentity(before) !== fileIdentity(after)) {
      throw new WorkspaceError(
        "E_WORKSPACE_UNSTABLE",
        `Workspace symbolic link changed while fingerprinting: ${path}`,
      );
    }
    return {
      path,
      kind: "symlink",
      mode: "120000",
      ...digestBuffer(target),
    };
  }
  if (!status.isFile()) {
    throw new WorkspaceError(
      "E_WORKSPACE_TYPE",
      `Tracked workspace entry must be a file or symbolic link: ${path}`,
    );
  }
  return {
    ...(await stableFileSummary(absolute, path)),
    kind: "file",
    mode: regularMode(status),
  };
};

const untrackedEntry = async (repoRoot, path) => {
  const absolute = await safeWorkspaceTarget(repoRoot, path);
  const status = await inspect(absolute);
  if (status?.isSymbolicLink()) {
    throw new WorkspaceError(
      "E_WORKSPACE_SYMLINK",
      `Cannot fingerprint untracked symbolic link: ${path}`,
    );
  }
  if (!status?.isFile()) {
    throw new WorkspaceError(
      "E_WORKSPACE_TYPE",
      `Cannot fingerprint non-file workspace entry: ${path}`,
    );
  }
  return {
    ...(await stableFileSummary(absolute, path)),
    mode: regularMode(status),
  };
};

const submoduleEntry = async (repoRoot, path, indexEntries) => {
  const absolute = await safeWorkspaceTarget(repoRoot, path);
  const status = await inspect(absolute);
  const index = indexEntries.map(({ mode, objectId, stage }) => ({
    mode,
    objectId,
    stage,
  }));
  if (!status) return { path, index, checkout: "missing", head: null };
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new WorkspaceError(
      "E_SUBMODULE_TYPE",
      `Submodule checkout must be a real directory: ${path}`,
    );
  }
  const dotGit = await inspect(resolve(absolute, ".git"));
  if (!dotGit) return { path, index, checkout: "uninitialized", head: null };
  if (dotGit.isSymbolicLink() || (!dotGit.isFile() && !dotGit.isDirectory())) {
    throw new WorkspaceError(
      "E_SUBMODULE_GITDIR",
      `Submodule metadata path is unsafe: ${path}`,
    );
  }
  try {
    const head = decodeGit(
      await runGit(absolute, ["rev-parse", "--verify", "HEAD"]),
      `Submodule ${path}`,
    ).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("invalid HEAD");
    return { path, index, checkout: "initialized", head };
  } catch {
    throw new WorkspaceError(
      "E_SUBMODULE_HEAD",
      `Submodule HEAD cannot be read safely: ${path}`,
    );
  }
};

const captureWorkspace = async ({ repoRoot, recorderRelativePath }) => {
  const headRaw = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const head = decodeGit(
    headRaw,
    "Git HEAD",
  ).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(head)) {
    throw new WorkspaceError("E_GIT_HEAD", "Git HEAD is not a supported object ID.");
  }

  const indexRaw = await runGit(repoRoot, [
    "ls-files",
    "--stage",
    "-z",
    "--",
  ]);
  const untrackedArguments = [
    "-c",
    "core.excludesFile=",
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ];
  const untrackedRaw = await runGit(repoRoot, untrackedArguments);
  const indexEntries = parseIndex(indexRaw, recorderRelativePath);
  const untrackedPaths = parseUntracked(
    untrackedRaw,
    recorderRelativePath,
  );

  const trackedPaths = [
    ...new Set(
      indexEntries
        .filter(({ mode }) => mode !== "160000")
        .map(({ path }) => path),
    ),
  ].sort(compareCodeUnits);
  const worktreeEntries = [];
  for (const path of trackedPaths) {
    worktreeEntries.push(await trackedWorktreeEntry(repoRoot, path));
  }

  const untracked = [];
  for (const path of untrackedPaths) {
    untracked.push(await untrackedEntry(repoRoot, path));
  }

  const gitlinkPaths = [
    ...new Set(
      indexEntries
        .filter(({ mode }) => mode === "160000")
        .map(({ path }) => path),
    ),
  ].sort(compareCodeUnits);
  const submoduleEntries = [];
  for (const path of gitlinkPaths) {
    submoduleEntries.push(
      await submoduleEntry(
        repoRoot,
        path,
        indexEntries.filter((entry) => entry.path === path),
      ),
    );
  }

  const endHeadRaw = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const endIndexRaw = await runGit(repoRoot, [
    "ls-files",
    "--stage",
    "-z",
    "--",
  ]);
  const endUntrackedRaw = await runGit(repoRoot, untrackedArguments);
  if (
    !headRaw.equals(endHeadRaw) ||
    !indexRaw.equals(endIndexRaw) ||
    !untrackedRaw.equals(endUntrackedRaw)
  ) {
    throw new WorkspaceError(
      "E_WORKSPACE_UNSTABLE",
      "Git metadata changed during the fingerprint capture.",
    );
  }

  return {
    version: 1,
    vcs: "git",
    head,
    excludedRecorderPath: recorderRelativePath,
    index: digestCanonical(indexEntries),
    worktree: digestCanonical(worktreeEntries),
    untracked,
    submodules: digestCanonical(submoduleEntries),
  };
};

export const fingerprintWorkspace = async ({
  repoRoot,
  recorderRelativePath,
}) => {
  if (!isPortableRelativePath(recorderRelativePath)) {
    throw new WorkspaceError(
      "E_RECORDER_PATH_PORTABLE",
      "Recorder path must use the portable path contract.",
    );
  }

  let previous = null;
  for (let attempt = 0; attempt < stableCaptureLimit; attempt += 1) {
    let current;
    try {
      current = await captureWorkspace({ repoRoot, recorderRelativePath });
    } catch (error) {
      if (error.code === "E_WORKSPACE_UNSTABLE") {
        previous = null;
        continue;
      }
      throw error;
    }
    if (previous && canonicalJson(previous) === canonicalJson(current)) {
      return current;
    }
    previous = current;
  }
  throw new WorkspaceError(
    "E_WORKSPACE_UNSTABLE",
    "Workspace kept changing during the bounded fingerprint capture.",
  );
};

export const assertSafeFile = async (root, path) =>
  assertExistingPath(root, path, "file");

export const assertSafeDirectory = async (root, path) =>
  assertExistingPath(root, path, "directory");
