# CI verification and attestation v1

Flight Recorder's GitHub Action turns one existing verification command into a
portable evidence bundle. It invokes the command as an exact argument array,
applies a fast Git-clean preflight, compares full non-ignored workspace
snapshots before and after execution, seals a handoff capsule, and accepts the
run only after that capsule returns `VALID` both locally and in a fresh clone
of the recorded commit.

The Action itself needs no GitHub token, network call, account, secret, or
write permission. A repository can optionally pass the capsule and the
limited-field predicate to GitHub's official `actions/attest` Action on a
trusted default-branch run. That separate step signs a statement binding the
capsule bytes to the adopting repository, workflow, commit, event, and run.

This is execution provenance, not a correctness oracle. A maintainer can choose
a weak command, and a passing command can contain weak tests.

## Input contract

`task` is required and follows the normal Flight Recorder task contract:
non-whitespace text, no ASCII control characters, and no more than 200 Unicode
code points.

`argv` is required JSON containing between 1 and 128 strings and at most 16 KiB
of UTF-8 input. The first string is the executable. Every later string is one
argument:

```yaml
with:
  task: Verify the reviewed checkout
  argv: '["npm","test"]'
```

The Action uses Node's spawn API with `shell: false`. It never parses a shell
command string. A workflow may explicitly name a shell executable in the
array, but that choice remains visible in the receipt. On Windows, npm's
`.cmd` launcher requires an explicit interpreter:

```yaml
with:
  task: Verify the reviewed checkout
  argv: '["cmd.exe","/d","/s","/c","npm test"]'
```

Do not place passwords, tokens, private repository URLs, customer content, or
other secrets in either input. The task and exact argument array are retained
inside the complete local recorder. The staged capsule also retains the task,
while the staged predicate retains only digests and policy fields. Command
stdout and stderr are streamed into the ordinary GitHub Actions log and are
subject to that log's visibility and retention, even though the receipt
retains only hashes and byte counts.

As defense in depth, the Action removes directly inherited GitHub file-command
paths, OIDC request credentials, runtime tokens, and `GITHUB_TOKEN` from the
child environment. It does not remove arbitrary environment variables
configured by the adopting workflow, supervise descendant processes, or
sandbox same-user code from the runner. A hostile command can tamper with its
own job. Use a read-only job without repository secrets, write permissions,
OIDC, or deployment authority.

## Result contract

A successful Action emits:

- `outcome`: exactly `VALID`;
- `recorder-path`: the complete local evidence directory, requiring review
  before any separate sharing;
- `receipt-path`: the observed command receipt;
- `capsule-path`: the verified handoff capsule;
- `predicate-path`: the custom predicate described below;
- `attestation-bundle-path`: a privacy-reduced staging directory containing only
  `capsule.json` and `predicate.json`;
- `attestation-capsule-path`: the exact staged `capsule.json`;
- `attestation-predicate-path`: the exact staged `predicate.json`;
- `capsule-content-digest`: the capsule's canonical internal digest;
- `capsule-file-digest`: SHA-256 of the raw capsule file;
- `predicate-file-digest`: SHA-256 of the raw predicate file;
- `workspace-head`: the Git HEAD in the exact workspace fingerprint.

The Action fails without reporting success when:

- the input or GitHub environment is invalid;
- the non-ignored workspace is already dirty;
- the command cannot spawn or exits unsuccessfully;
- the tracked, staged, or non-ignored untracked endpoint snapshot differs
  after the command;
- a trusted `push` or `workflow_dispatch` checkout does not match
  `GITHUB_SHA`;
- sealing or exact local and clean-clone verification does not return `VALID`;
  or
- evidence or output publication fails.

Git-ignored files are outside the v1 workspace fingerprint and cleanliness
preflight. A command may write ignored build caches and still pass.
Assume-unchanged and skip-worktree index entries are rejected. Executable Git
content filters (`clean`, `smudge`, or `process`) are rejected before Git
status runs. Initialized submodules are also rejected before status because v1
will not fetch or initialize submodule content in its clean-clone proof.
Hydrated LFS, sparse-checkout, and initialized-submodule worktrees therefore
fail closed. General snapshot limitations remain those documented in
[Handoff Interchange Contract v1](HANDOFF_V1.md).

Every Git metadata subprocess receives only path, platform, locale, and
temporary-directory environment values; GitHub tokens, OIDC credentials,
file-command paths, and arbitrary workflow variables are not forwarded.
This is defense in depth, not a transactional lock against another same-user
process racing to change repository configuration.

Matching endpoint snapshots do not prove continuous immutability. A command
can change a file and restore the exact bytes and mode before it exits. The
predicate therefore says `workspaceSnapshotsMatched`, not that the workspace
was immutable throughout execution.

## Read-only pull-request check

Use the Action only after the project's normal setup and dependency-install
steps. Pin every third-party Action to a full commit SHA. Replace
`<FLIGHT_RECORDER_RELEASE_COMMIT_SHA>` with the full reviewed Flight Recorder
release commit; a branch name or movable tag is not an immutable security pin.

```yaml
name: Evidence

on:
  pull_request:

permissions:
  contents: read

jobs:
  test-with-evidence:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Keep the project's existing setup and install steps here.

      - name: Test and create Flight Recorder evidence
        id: evidence
        uses: techbantu/flight-recorder@<FLIGHT_RECORDER_RELEASE_COMMIT_SHA>
        with:
          task: Verify the pull-request checkout
          argv: '["npm","test"]'

      - name: Retain the two exact attestation inputs
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: flight-recorder-${{ github.run_id }}-${{ github.run_attempt }}
          path: |
            ${{ steps.evidence.outputs.attestation-capsule-path }}
            ${{ steps.evidence.outputs.attestation-predicate-path }}
          if-no-files-found: error
          retention-days: 30
```

Do not change this to `pull_request_target`, add repository secrets, or grant
write permission. Contributor-controlled code and commands must not run in a
privileged workflow context.

Keep the upload allowlist as the two exact file outputs. Do not recursively
upload either `attestation-bundle-path` or `recorder-path`. A same-user process
can add an unexpected directory entry after the Action returns, and the mutable
recorder can contain task text, exact arguments, or user-authored content.

## Signed default-branch evidence

GitHub artifact attestations are available for public repositories on current
GitHub plans. Keep evidence generation and signing in separate jobs. The first
job runs project code with `contents: read` only. The second job receives the
exact uploaded artifact ID and has signing authority, but does not check out or
execute project code.

```yaml
name: Signed evidence

on:
  push:
    branches:
      - main

jobs:
  evidence:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    outputs:
      artifact-id: ${{ steps.upload.outputs.artifact-id }}
      capsule-file-digest: ${{ steps.evidence.outputs.capsule-file-digest }}
      predicate-file-digest: ${{ steps.evidence.outputs.predicate-file-digest }}
    steps:
      - name: Check out
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Keep the project's existing setup and install steps here.

      - name: Test and create Flight Recorder evidence
        id: evidence
        uses: techbantu/flight-recorder@<FLIGHT_RECORDER_RELEASE_COMMIT_SHA>
        with:
          task: Verify the default-branch checkout
          argv: '["npm","test"]'

      - name: Retain the two exact attestation inputs
        id: upload
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: flight-recorder-${{ github.run_id }}-${{ github.run_attempt }}
          path: |
            ${{ steps.evidence.outputs.attestation-capsule-path }}
            ${{ steps.evidence.outputs.attestation-predicate-path }}
          if-no-files-found: error
          retention-days: 90

  attest:
    needs: evidence
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: read
      contents: read
      id-token: write
      attestations: write
    steps:
      - name: Download the exact evidence artifact
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          artifact-ids: ${{ needs.evidence.outputs.artifact-id }}
          path: ${{ runner.temp }}/flight-recorder-evidence
          digest-mismatch: error

      - name: Validate the exact evidence files
        shell: bash
        env:
          EXPECTED_CAPSULE_DIGEST: ${{ needs.evidence.outputs.capsule-file-digest }}
          EXPECTED_PREDICATE_DIGEST: ${{ needs.evidence.outputs.predicate-file-digest }}
        run: |
          set -euo pipefail
          evidence="${RUNNER_TEMP}/flight-recorder-evidence"
          mapfile -d '' entries < <(
            find "$evidence" -mindepth 1 -maxdepth 1 -print0
          )
          test "${#entries[@]}" -eq 2
          test -f "$evidence/capsule.json"
          test ! -L "$evidence/capsule.json"
          test -f "$evidence/predicate.json"
          test ! -L "$evidence/predicate.json"
          capsule_digest="sha256:$(sha256sum "$evidence/capsule.json" | cut -d ' ' -f 1)"
          predicate_digest="sha256:$(sha256sum "$evidence/predicate.json" | cut -d ' ' -f 1)"
          test "$capsule_digest" = "$EXPECTED_CAPSULE_DIGEST"
          test "$predicate_digest" = "$EXPECTED_PREDICATE_DIGEST"

      - name: Sign the verification predicate
        id: attestation
        uses: actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d # v4.2.1
        with:
          subject-path: ${{ runner.temp }}/flight-recorder-evidence/capsule.json
          predicate-type: https://github.com/techbantu/flight-recorder/attestation/ci-verification/v1
          predicate-path: ${{ runner.temp }}/flight-recorder-evidence/predicate.json
```

The adopting repository—not Flight Recorder—owns that signature. The
attestation proves which GitHub signing job signed the downloaded capsule
bytes. It does not prove that the selected command was meaningful, that the
producer job was non-malicious, or that the predicate is a correctness claim.
Keeping OIDC and attestation permission out of the evidence job prevents the
project's test process from minting a signing identity.

## Predicate

`schema/ci-verification-v1.schema.json` defines the predicate. It contains:

- tool name and version;
- capsule content and raw-file digests;
- Git workspace HEAD and canonical fingerprint digest;
- an unsalted digest commitment to the exact argument array, providing
  equality and integrity rather than confidentiality;
- the receipt-file digest, bound to the capsule's single receipt summary; and
- the enforced `spawnShell: false`, `workspaceSnapshotsMatched: true`, and
  `cleanCloneVerified: true` policy.

The predicate deliberately omits the task, exact arguments, environment,
stdout, and stderr. The staged capsule does retain the task, recorder path,
workspace fingerprint, and file summaries. The complete local recorder also
contains the exact arguments, user-authored artifacts, and receipt metadata,
while GitHub's ordinary workflow log contains command stdout and stderr. The
argument digest is unsalted, so anyone with a candidate argument array can
recompute or dictionary-test it. Review all retained surfaces before any
separate sharing.

## Verification and removal

Verify the signed capsule against one expected workflow, default-branch ref,
commit, predicate type, and GitHub-hosted runner. Save the structured result
for the custom-predicate policy check:

```bash
EXPECTED_COMMIT=<40-character-adopter-commit>

gh attestation verify path/to/capsule.json \
  --repo OWNER/REPOSITORY \
  --signer-workflow OWNER/REPOSITORY/.github/workflows/signed-evidence.yml \
  --source-ref refs/heads/main \
  --source-digest "$EXPECTED_COMMIT" \
  --deny-self-hosted-runners \
  --predicate-type \
  https://github.com/techbantu/flight-recorder/attestation/ci-verification/v1 \
  --format json > verification.json

node /path/to/pinned-flight-recorder/scripts/verify-attestation-policy.js \
  verification.json \
  path/to/capsule.json \
  "$EXPECTED_COMMIT"
```

The policy script requires exactly one attestation and one subject, validates
the capsule and predicate's closed v1 structures, recomputes the capsule's raw
and canonical digests, requires exactly one summarized receipt, binds its digest
to the predicate, and requires the capsule, predicate, and expected commit to
agree. The exact-argument digest remains a signed commitment; independently
recomputing a candidate does not require the private receipt and provides no
confidentiality.
The GitHub CLI flags enforce signer identity, source ref/digest, and hosted
runner identity from the signed certificate.

To recheck a complete local recorder, obtain the exact pinned Flight Recorder
source separately. Run its CLI while the working directory remains the adopter
checkout at the recorded commit:

```bash
git clone https://github.com/techbantu/flight-recorder.git \
  /path/to/pinned-flight-recorder
git -C /path/to/pinned-flight-recorder checkout --detach \
  <FLIGHT_RECORDER_RELEASE_COMMIT_SHA>

cd /path/to/adopter-checkout
node /path/to/pinned-flight-recorder/bin/fr.js verify \
  .flight-recorder/evidence-<id>/capsules/sha256-<digest>.json
```

The two-file attestation bundle is intentionally insufficient for full local
`fr verify`; it omits private artifacts and the exact command receipt.

Removal is one workflow edit: delete the Flight Recorder, upload, and
attestation steps. Deleting an expiring workflow artifact or an existing
attestation is a separate repository-owner decision.
