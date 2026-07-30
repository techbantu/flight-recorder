# Environment

## Requirements

- Node.js 20 or newer
- Git with an existing `HEAD` for run, seal, verify, and Action evidence
- Claude Code only for the optional plugin validator and adapter

The core CLI and Action have no runtime or development dependencies and need
no API key or application secret.

The CLI supports Node.js 20 and newer. GitHub executes the JavaScript Action
with its current Node.js 24 Action runtime.

## Local proof

```bash
npm ci
npm run check
npm pack --dry-run
npm run plugin:validate
```

Expected: syntax checks and tests pass, the package list contains the declared
CLI, Action, schemas, templates, and docs, and strict plugin validation exits
successfully.

## GitHub Action environment

GitHub supplies `GITHUB_WORKSPACE`, `GITHUB_OUTPUT`, and
`GITHUB_STEP_SUMMARY`, plus `RUNNER_TEMP` for clean-clone verification and the
privacy-reduced attestation staging directory. Trusted `push` and
`workflow_dispatch` runs also bind the evidence workspace to `GITHUB_SHA`.

The Action itself does not read `GITHUB_TOKEN`, make a network request, or
require a secret. Optional signing is performed by the separate official
`actions/attest` step using GitHub OIDC and repository-scoped permissions.

## Failure behavior

Missing environment, invalid input, pre-existing workspace dirt, child failure,
snapshot mismatch, HEAD mismatch, unexpected evidence, sealing failure, or
local/clean-clone verification failure stops the Action without a success
output. The observed receipt may remain on the ephemeral runner for diagnosis.

There are no project secrets to rotate. If an adopting workflow exposes a
secret through its own command arguments or artifacts, rotate it at its source
and remove the affected workflow artifacts or attestations under that
repository's incident procedure.
