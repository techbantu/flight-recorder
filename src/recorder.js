import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  isPortableRelativePath,
  isRecord,
  isValidTask,
} from "./contracts.js";

const templates = {
  state: new URL("../templates/state.json", import.meta.url),
  decisions: new URL("../templates/decisions.log", import.meta.url),
  checks: new URL("../templates/checks.md", import.meta.url),
  resume: new URL("../templates/resume.md", import.meta.url),
};

const missing = Symbol("missing");
const schemaVersion = 1;

export class RecorderError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "RecorderError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const inspect = async (path) =>
  lstat(path).catch((error) => {
    if (error.code === "ENOENT") return missing;
    throw error;
  });

const validateTask = (task) => {
  const normalized = task.trim();

  if (!normalized) {
    throw new RecorderError("E_TASK_EMPTY", "Provide a task name.", 2);
  }

  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new RecorderError(
      "E_TASK_CONTROL",
      "Task names cannot contain control characters.",
      2,
    );
  }

  if (!isValidTask(normalized)) {
    throw new RecorderError(
      "E_TASK_LONG",
      "Task names must be 200 characters or fewer.",
      2,
    );
  }

  return normalized;
};

const taskSlug = (task) => {
  const slug = task
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64)
    .replace(/-$/u, "");

  if (!slug) {
    throw new RecorderError(
      "E_TASK_SLUG",
      "Task names must contain at least one Latin letter or number.",
      2,
    );
  }

  return slug;
};

const validateDirectory = (directory) => {
  if (directory === undefined) return undefined;
  if (!directory.trim()) {
    throw new RecorderError("E_DIR_EMPTY", "--dir requires a non-empty path.", 2);
  }
  if (/[\u0000-\u001f\u007f]/u.test(directory)) {
    throw new RecorderError(
      "E_DIR_CONTROL",
      "Directory paths cannot contain control characters.",
      2,
    );
  }
  return directory;
};

const assertContainedTarget = async (cwd, target) => {
  const root = resolve(cwd);
  const boundary = relative(root, target);
  const escapesWorkingDirectory =
    boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary);

  if (escapesWorkingDirectory) {
    throw new RecorderError(
      "E_DIR_OUTSIDE",
      "--dir must resolve inside the current working directory.",
      2,
    );
  }
  const portableBoundary = boundary.split(sep).join("/");
  if (portableBoundary && !isPortableRelativePath(portableBoundary)) {
    throw new RecorderError(
      "E_DIR_PORTABLE",
      "--dir must use a portable relative path without colons or ambiguous segments.",
      2,
    );
  }

  const segments = boundary ? boundary.split(sep) : [];
  let current = root;

  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const status = await inspect(current);
    if (status === missing) break;
    if (status.isSymbolicLink()) {
      throw new RecorderError(
        "E_DIR_SYMLINK",
        "--dir cannot traverse a symbolic link.",
        2,
      );
    }
    if (!status.isDirectory() && index < segments.length - 1) {
      throw new RecorderError(
        "E_TARGET_TYPE",
        `Target ancestor is not a directory: ${current}`,
      );
    }
  }
};

const loadArtifacts = async (task) => {
  const [stateTemplate, decisions, checks, resume] = await Promise.all([
    readFile(templates.state, "utf8"),
    readFile(templates.decisions, "utf8"),
    readFile(templates.checks, "utf8"),
    readFile(templates.resume, "utf8"),
  ]);
  const state = JSON.parse(stateTemplate);

  return [
    {
      path: "state.json",
      kind: "file",
      content: `${JSON.stringify({ ...state, activeTask: task }, null, 2)}\n`,
    },
    { path: "decisions.log", kind: "file", content: decisions },
    { path: "checks.md", kind: "file", content: checks },
    {
      path: "resume.md",
      kind: "file",
      content: resume.replaceAll("{{TASK}}", () => task),
    },
    { path: "receipts", kind: "directory" },
  ];
};

const validateExistingState = async (path, task) => {
  const content = await readFile(path, "utf8");
  let state;

  try {
    state = JSON.parse(content);
  } catch {
    throw new RecorderError(
      "E_STATE_INVALID",
      "Existing state.json is not valid JSON. No files were changed.",
    );
  }

  const matchesSchema =
    isRecord(state) &&
    state.schemaVersion === schemaVersion &&
    typeof state.project === "string" &&
    typeof state.mode === "string" &&
    isValidTask(state.activeTask) &&
    isRecord(state.ids) &&
    (state.lastUpdated === null || typeof state.lastUpdated === "string");

  if (!matchesSchema) {
    throw new RecorderError(
      "E_STATE_SCHEMA",
      `Existing state.json is not Flight Recorder schema ${schemaVersion}. No files were changed.`,
    );
  }

  if (state.activeTask !== task) {
    throw new RecorderError(
      "E_TASK_MISMATCH",
      "Existing recorder belongs to a different task. Choose another --dir. No files were changed.",
    );
  }
};

const preflight = async (target, artifacts, task) => {
  const targetStatus = await inspect(target);

  if (targetStatus !== missing && !targetStatus.isDirectory()) {
    throw new RecorderError(
      "E_TARGET_TYPE",
      `Target exists but is not a directory: ${target}`,
    );
  }

  const entries = targetStatus === missing ? [] : await readdir(target);
  const expectedNames = new Set(artifacts.map(({ path }) => path));
  const hasRecorderArtifact = entries.some((entry) => expectedNames.has(entry));

  if (entries.length > 0 && !hasRecorderArtifact) {
    throw new RecorderError(
      "E_TARGET_NOT_EMPTY",
      `Target is not empty and does not contain a flight recorder: ${target}`,
    );
  }

  const statuses = await Promise.all(
    artifacts.map(async (artifact) => ({
      artifact,
      status: await inspect(resolve(target, artifact.path)),
    })),
  );

  statuses.forEach(({ artifact, status }) => {
    if (status === missing) return;
    const expectedTypeMatches =
      artifact.kind === "file" ? status.isFile() : status.isDirectory();

    if (!expectedTypeMatches) {
      throw new RecorderError(
        "E_TARGET_TYPE",
        `${resolve(target, artifact.path)} must be a ${artifact.kind}. No files were changed.`,
      );
    }
  });

  if (entries.length > 0) {
    const stateStatus = statuses.find(({ artifact }) => artifact.path === "state.json");
    if (stateStatus.status === missing) {
      throw new RecorderError(
        "E_STATE_MISSING",
        "Non-empty target is missing Flight Recorder state.json. No files were changed.",
      );
    }
    await validateExistingState(resolve(target, "state.json"), task);
  }

  return statuses;
};

const createArtifact = async (target, artifact) => {
  const path = resolve(target, artifact.path);

  try {
    if (artifact.kind === "directory") {
      await mkdir(path);
    } else {
      await writeFile(path, artifact.content, { encoding: "utf8", flag: "wx" });
    }
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const status = await inspect(path);
    const expectedTypeMatches =
      status !== missing &&
      (artifact.kind === "file" ? status.isFile() : status.isDirectory());
    if (expectedTypeMatches) return false;
    throw error;
  }
};

export const initializeRecorder = async ({
  task: unvalidatedTask,
  directory: unvalidatedDirectory,
  cwd = process.cwd(),
}) => {
  const task = validateTask(unvalidatedTask);
  const directory = validateDirectory(unvalidatedDirectory);
  const target = resolve(cwd, directory ?? "ops", directory ? "" : taskSlug(task));
  await assertContainedTarget(cwd, target);
  const artifacts = await loadArtifacts(task);
  const statuses = await preflight(target, artifacts, task);

  await mkdir(target, { recursive: true });

  const created = [];
  const preserved = [];

  for (const { artifact, status } of statuses) {
    if (status !== missing) {
      preserved.push(artifact.path);
      continue;
    }

    if (await createArtifact(target, artifact)) {
      created.push(artifact.path);
    } else {
      preserved.push(artifact.path);
    }
  }

  return { target, created, preserved };
};
