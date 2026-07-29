#!/usr/bin/env node

import { relative } from "node:path";
import { initializeRecorder, RecorderError } from "../src/recorder.js";

const help = `Usage: fr-init <task name> [--dir <path>]

Create a local flight recorder without overwriting existing evidence.

Options:
  -d, --dir <path>  Choose the recorder directory (default: ops/<task-slug>)
  -h, --help        Show this help
`;

const usageError = (code, message) => new RecorderError(code, message, 2);

const parseArguments = (arguments_) => {
  const taskParts = [];
  let directory;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }

    if (argument === "--") {
      taskParts.push(...arguments_.slice(index + 1));
      break;
    }

    if (argument === "--dir" || argument === "-d") {
      if (directory !== undefined) {
        throw usageError("E_DIR_DUPLICATE", "--dir can only be provided once.");
      }
      directory = arguments_[index + 1];
      if (directory === undefined) {
        throw usageError("E_DIR_MISSING", "--dir requires a path.");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--dir=")) {
      if (directory !== undefined) {
        throw usageError("E_DIR_DUPLICATE", "--dir can only be provided once.");
      }
      directory = argument.slice("--dir=".length);
      continue;
    }

    if (argument.startsWith("-")) {
      throw usageError("E_OPTION_UNKNOWN", `Unknown option: ${argument}`);
    }

    taskParts.push(argument);
  }

  return { task: taskParts.join(" "), directory };
};

const displayPath = (target) => relative(process.cwd(), target) || ".";
const displayArtifact = (path) => (path === "receipts" ? "receipts/" : path);

const printResult = ({ target, created, preserved }) => {
  const path = displayPath(target);
  const heading =
    preserved.length === 0
      ? `Created flight recorder at ${path}`
      : created.length === 0
        ? `Flight recorder already exists at ${path}`
        : `Repaired flight recorder at ${path}`;

  process.stdout.write(`${heading}\n`);
  process.stdout.write(
    created.length > 0
      ? `Created: ${created.map(displayArtifact).join(", ")}\n`
      : "No files changed.\n",
  );
  if (preserved.length > 0 && created.length > 0) {
    process.stdout.write(`Preserved: ${preserved.map(displayArtifact).join(", ")}\n`);
  }
};

try {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(help);
  } else {
    printResult(await initializeRecorder(options));
  }
} catch (error) {
  const failure =
    error instanceof RecorderError
      ? error
      : new RecorderError(
          "E_IO",
          `Initialization failed: ${error.message}. Re-run safely; existing artifacts were not overwritten.`,
        );

  process.stderr.write(`[${failure.code}] ${failure.message}\n`);
  process.exitCode = failure.exitCode;
}
