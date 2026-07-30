import {
  CIEvidenceError,
  createCIEvidence,
} from "../src/ci-evidence.js";

try {
  await createCIEvidence({ environment: process.env });
} catch (error) {
  const failure =
    error instanceof CIEvidenceError
      ? error
      : new CIEvidenceError(
          error.code ?? "E_ACTION_INTERNAL",
          error.message ?? "Flight Recorder evidence generation failed.",
        );
  process.stderr.write(`[${failure.code}] ${failure.message}\n`);
  process.exitCode = failure.exitCode;
}
