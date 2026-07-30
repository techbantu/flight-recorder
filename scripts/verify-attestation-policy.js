#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateCapsuleStructure } from "../src/handoff.js";
import { canonicalJson, sha256 } from "../src/integrity.js";

const predicateType =
  "https://github.com/techbantu/flight-recorder/attestation/ci-verification/v1";
const sha256Digest = /^sha256:[a-f0-9]{64}$/u;
const gitObjectId = /^[a-f0-9]{40,64}$/u;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMatchingString = (value, pattern) =>
  typeof value === "string" && pattern.test(value);

const hasExactKeys = (value, keys) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const fail = (message) => {
  process.stderr.write(`[E_ATTESTATION_POLICY] ${message}\n`);
  process.exitCode = 6;
};

const validatePredicate = (value) =>
  hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "outcome",
    "tool",
    "capsuleContentDigest",
    "capsuleFileDigest",
    "workspaceHead",
    "workspaceFingerprintDigest",
    "commandArgvDigest",
    "receiptFileDigest",
    "policy",
  ]) &&
  value.schemaVersion === 1 &&
  value.kind === "dev.flight-recorder.ci-verification" &&
  value.outcome === "VALID" &&
  hasExactKeys(value.tool, ["name", "version"]) &&
  value.tool.name === "@techbantu/flight-recorder" &&
  isMatchingString(value.tool.version, semver) &&
  isMatchingString(value.capsuleContentDigest, sha256Digest) &&
  isMatchingString(value.capsuleFileDigest, sha256Digest) &&
  isMatchingString(value.workspaceHead, gitObjectId) &&
  isMatchingString(value.workspaceFingerprintDigest, sha256Digest) &&
  isMatchingString(value.commandArgvDigest, sha256Digest) &&
  isMatchingString(value.receiptFileDigest, sha256Digest) &&
  hasExactKeys(value.policy, [
    "cleanCloneVerified",
    "spawnShell",
    "workspaceSnapshotsMatched",
  ]) &&
  value.policy.cleanCloneVerified === true &&
  value.policy.spawnShell === false &&
  value.policy.workspaceSnapshotsMatched === true;

const [verificationPath, capsulePath, expectedHead] = process.argv.slice(2);
if (
  !verificationPath ||
  !capsulePath ||
  !expectedHead ||
  !isMatchingString(expectedHead, gitObjectId)
) {
  fail(
    "Usage: verify-attestation-policy <gh-verification.json> <capsule.json> <expected-head>.",
  );
} else {
  try {
    const [verificationText, capsuleBytes] = await Promise.all([
      readFile(verificationPath, "utf8"),
      readFile(capsulePath),
    ]);
    const verification = JSON.parse(verificationText);
    const capsule = JSON.parse(capsuleBytes.toString("utf8"));
    if (!Array.isArray(verification) || verification.length !== 1) {
      throw new Error("Expected exactly one verified attestation.");
    }
    const statement = verification[0]?.verificationResult?.statement;
    if (!isRecord(statement) || statement.predicateType !== predicateType) {
      throw new Error("The verified statement has the wrong predicate type.");
    }
    if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
      throw new Error("Expected exactly one attested subject.");
    }
    const subjectDigest = statement.subject[0]?.digest?.sha256;
    const capsuleFileDigest = createHash("sha256")
      .update(capsuleBytes)
      .digest("hex");
    if (subjectDigest !== capsuleFileDigest) {
      throw new Error("The signed subject digest does not match capsule.json.");
    }
    const predicate = statement.predicate;
    if (!validatePredicate(predicate)) {
      throw new Error("The custom predicate does not satisfy policy schema v1.");
    }
    if (predicate.capsuleFileDigest !== `sha256:${capsuleFileDigest}`) {
      throw new Error("The predicate capsule file digest does not match.");
    }
    if (!validateCapsuleStructure(capsule)) {
      throw new Error("The capsule does not satisfy the closed v1 structure.");
    }
    if (capsule.receipts.length !== 1) {
      throw new Error("The Action capsule must summarize exactly one receipt.");
    }
    if (
      predicate.receiptFileDigest !==
      `sha256:${capsule.receipts[0].sha256}`
    ) {
      throw new Error("The predicate receipt digest does not match the capsule.");
    }
    if (
      capsule.contentDigest !== predicate.capsuleContentDigest ||
      capsule.workspace.head !== expectedHead ||
      predicate.workspaceHead !== expectedHead
    ) {
      throw new Error("The capsule and predicate are not bound to expected HEAD.");
    }
    const { contentDigest, ...unsignedCapsule } = capsule;
    if (
      contentDigest !==
      `sha256:${sha256(canonicalJson(unsignedCapsule))}`
    ) {
      throw new Error("The capsule canonical content digest does not match.");
    }
    if (
      predicate.workspaceFingerprintDigest !==
      `sha256:${sha256(canonicalJson(capsule.workspace))}`
    ) {
      throw new Error("The predicate workspace fingerprint digest does not match.");
    }
    process.stdout.write("ATTESTATION_POLICY_VALID\n");
  } catch (error) {
    fail(error.message ?? "Attestation policy verification failed.");
  }
}
