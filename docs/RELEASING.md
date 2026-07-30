# Releasing

Publishing is a maintainer approval step. A green pull request does not publish
the package.

## Pre-release proof

1. Confirm the intended version is not already present:
   `npm view @techbantu/flight-recorder version`
2. Update `package.json`, `package-lock.json`,
   `.claude-plugin/plugin.json`, and `CHANGELOG.md` together. The npm and
   plugin versions must match.
3. Run:

   ```bash
   npm ci
   npm run check
   npm pack --dry-run
   npm run plugin:validate
   ```

4. Inspect the dry-run file list for both executables, `action.yml`,
   `action/index.js`, `src/`, all four templates, `ADOPTION.md`,
   `docs/HANDOFF_V1.md`, `docs/CI_ATTESTATION_V1.md`, all three JSON Schemas
   under `schema/`, the Claude Code plugin manifest, and its one explicit-only
   `init` skill.
5. Run `npm pack --pack-destination <clean-temporary-directory>`, install that
   tarball in a separate empty project, and smoke-test creation, retry, and
   conflict rejection, literal-argument command capture, sealing, valid
   verification, and stale-workspace rejection on a supported Node version.
   On Windows, exercise the documented explicit
   `cmd.exe /d /s /c "npm --version"` observation path.
6. Generate a fresh capsule with one command receipt and validate both files
   with an independent JSON Schema Draft 2020-12 implementation. If using
   Ajv CLI, load `ajv-formats` for `date-time` and set
   `--strict-tuples=false`; the receipt intentionally requires a non-empty
   first argument while permitting any number of later string arguments.
7. Verify the default branch CI is green.

Validate the unpacked npm tarball as a Claude Code plugin too. Loading the
plugin must not invoke Flight Recorder or change the project working tree
before a user explicitly invokes the skill.

Submission to Anthropic's plugin directory is a separate, externally visible
maintainer approval step. Package validation and a green pull request do not
submit it.

Test the packed GitHub Action entrypoint from a clean Git checkout too. It must
preserve literal argument boundaries, reject command failure and non-ignored
endpoint drift, emit `VALID`, perform its own successful clean-clone
verification, reject executable Git filters and initialized submodules before
execution, stage exactly `capsule.json` and `predicate.json`, and leave task
text and exact arguments out of its predicate and step summary. Exercise the
public upload example with the two exact file outputs and validate both raw
digests before signing.

After a release commit is final, documentation and adopter examples must pin
that full 40-character commit. Do not represent a branch or movable tag as an
immutable security pin.

Creating a public GitHub artifact attestation is a separate external
publication step. It requires explicit maintainer approval and a trusted
default-branch workflow with no repository secrets. Verify the first public
attestation with `gh attestation verify` before describing signed evidence as
live. Enforce signer workflow, source ref/digest, and hosted-runner identity,
then run `scripts/verify-attestation-policy.js` over the structured verification
result, staged capsule, and expected commit.

## Publish

The maintainer must explicitly approve the irreversible publication command.
Use npm account protections required by the organization, including MFA. Do not
place an npm token in the repository or local shell history.

## Rollback

Do not silently replace a published version. If a release is defective:

1. deprecate the affected version with a specific warning;
2. publish a corrected patch version after the full pre-release proof;
3. document impact and migration in `CHANGELOG.md`;
4. remove a version only when npm policy permits it and the maintainer has
   explicitly approved the destructive action.

An Action consumer pinned to an immutable bad commit must change its workflow
to a corrected commit. Never move a tag and claim that an already-pinned
consumer received the fix.
