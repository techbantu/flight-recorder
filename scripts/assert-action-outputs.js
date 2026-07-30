import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

assert.equal(process.env.FLIGHT_RECORDER_OUTCOME, "VALID");
assert.match(
  process.env.FLIGHT_RECORDER_CONTENT_DIGEST ?? "",
  /^sha256:[a-f0-9]{64}$/u,
);
assert.match(
  process.env.FLIGHT_RECORDER_FILE_DIGEST ?? "",
  /^sha256:[a-f0-9]{64}$/u,
);
assert.match(
  process.env.FLIGHT_RECORDER_PREDICATE_DIGEST ?? "",
  /^sha256:[a-f0-9]{64}$/u,
);
assert.match(
  process.env.FLIGHT_RECORDER_WORKSPACE_HEAD ?? "",
  /^[a-f0-9]{40,64}$/u,
);
const bundle = process.env.FLIGHT_RECORDER_ATTESTATION_BUNDLE ?? "";
assert.notEqual(bundle, "");
assert.equal(
  process.env.FLIGHT_RECORDER_ATTESTATION_CAPSULE,
  join(bundle, "capsule.json"),
);
assert.equal(
  process.env.FLIGHT_RECORDER_ATTESTATION_PREDICATE,
  join(bundle, "predicate.json"),
);
assert.equal(
  process.env.FLIGHT_RECORDER_PREDICATE_DIGEST,
  `sha256:${createHash("sha256")
    .update(await readFile(join(bundle, "predicate.json")))
    .digest("hex")}`,
);
assert.deepEqual((await readdir(bundle)).sort(), [
  "capsule.json",
  "predicate.json",
]);
