#!/usr/bin/env node

import {
  HandoffError,
  invalidOutcome,
  runObservedCommand,
  sealRecorder,
  verifyCapsule,
} from "../src/handoff.js";

const help = `Usage:
  fr run <recorder-dir> -- <command> [arguments...]
  fr seal <recorder-dir>
  fr verify <capsule-path>

Create observed command receipts and self-checking, Git-bound handoff capsules.
Command output is streamed but only byte counts and SHA-256 hashes are stored.
`;

const usageError = (code, message) => new HandoffError(code, message, 2);

const parseRun = (arguments_) => {
  const separator = arguments_.indexOf("--");
  if (separator === -1) {
    throw usageError("E_COMMAND_SEPARATOR", "fr run requires -- before the command.");
  }
  const options = arguments_.slice(0, separator);
  const argv = arguments_.slice(separator + 1);
  const recorderArgument = options.shift();

  if (options.length > 0) {
    const option = options[0];
    throw usageError("E_OPTION_UNKNOWN", `Unknown run option: ${option}`);
  }

  return { recorderArgument, argv };
};

const exactArgument = (command, arguments_) => {
  if (arguments_.length !== 1) {
    throw usageError(
      "E_ARGUMENT_COUNT",
      `fr ${command} requires exactly one path.`,
    );
  }
  return arguments_[0];
};

const printOutcome = ({ name, detail }) => {
  process.stdout.write(`${name} ${detail}\n`);
};

const main = async () => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write(help);
    return;
  }

  if (command === "run") {
    const options = parseRun(arguments_);
    const result = await runObservedCommand({
      cwd: process.cwd(),
      ...options,
    });
    process.stderr.write(`RECORDED ${result.displayPath}\n`);
    process.exitCode = result.processExitCode;
    return;
  }

  if (command === "seal") {
    try {
      const result = await sealRecorder({
        cwd: process.cwd(),
        recorderArgument: exactArgument(command, arguments_),
      });
      process.stdout.write(`SEALED ${result.displayPath}\n`);
    } catch (error) {
      const result = invalidOutcome(error);
      printOutcome(result);
      process.exitCode = result.exitCode;
    }
    return;
  }

  if (command === "verify") {
    const result = await verifyCapsule({
      cwd: process.cwd(),
      capsuleArgument: exactArgument(command, arguments_),
    });
    printOutcome(result);
    process.exitCode = result.exitCode;
    return;
  }

  throw usageError("E_COMMAND_UNKNOWN", `Unknown command: ${command}`);
};

try {
  await main();
} catch (error) {
  const failure =
    error instanceof HandoffError
      ? error
      : new HandoffError(
          error.code ?? "E_IO",
          error.message ?? "Operation failed.",
        );
  process.stderr.write(`[${failure.code}] ${failure.message}\n`);
  process.exitCode = failure.exitCode;
}
