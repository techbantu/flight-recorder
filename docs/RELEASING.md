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

4. Inspect the dry-run file list for both executables, `src/`, all four
   templates, `docs/HANDOFF_V1.md`, both JSON Schemas under `schema/`, the
   Claude Code plugin manifest, and its one explicit-only `init` skill.
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
