# Releasing

Publishing is a maintainer approval step. A green pull request does not publish
the package.

## Pre-release proof

1. Confirm the intended version is not already present:
   `npm view @techbantu/flight-recorder version`
2. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` together.
3. Run:

   ```bash
   npm ci
   npm run check
   npm pack --dry-run
   ```

4. Inspect the dry-run file list for `bin/fr-init.js`, `src/`, and all four
   templates.
5. Run `npm pack --pack-destination <clean-temporary-directory>`, install that
   tarball in a separate empty project, and smoke-test creation, retry, and
   conflict rejection on a supported Node version.
6. Verify the default branch CI is green.

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
