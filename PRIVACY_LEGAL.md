# Privacy and legal

## Data inventory

Flight Recorder may write:

- task labels and user-authored state, decision, check, and resume artifacts;
- exact command argument arrays;
- command timing, exit, signal, byte-count, and output-hash metadata;
- Git workspace fingerprints and file paths;
- capsules, CI predicates, and GitHub step outputs.

It does not put stdout or stderr bytes into its own receipt or capsule; those
files retain only output hashes and byte counts. In GitHub Actions, the command
output is still streamed into and retained by the ordinary workflow log. It
does not separately retain environment variables, configured Git remotes,
passwords, accounts, payment data, or telemetry. Exact arguments,
user-authored files, and command output can still contain any of those values
if the operator places them there.

## Storage and transmission

Core CLI execution stores files only under the chosen local workspace. The
GitHub Action stores the complete recorder on the runner and separately stages
a privacy-reduced `capsule.json` and `predicate.json`. The capsule retains the
task label, recorder path, workspace fingerprint, and file summaries; the
predicate retains digests and policy fields. Exact arguments, receipts,
user-authored artifacts, stdout, stderr, and environment are not copied into
those two staged files. An adopting workflow may explicitly upload the exact
file outputs to GitHub Actions, validate both raw digests, and sign the capsule
as subject with the predicate embedded. Directory uploads are intentionally
not recommended because another same-user process could add an entry after
staging. The optional Claude Code skill sends its supplied task through the
user's configured Claude Code interaction.

The executable command may independently use the network or other services.
That behavior belongs to the command, not Flight Recorder.

## Export, deletion, and retention

Local export is a file copy and local deletion is normal filesystem deletion.
GitHub artifact retention is selected by the adopting repository. Removing an
uploaded artifact or published attestation is a separate repository-owner
action governed by GitHub's controls and retention behavior.

Flight Recorder has no account, central database, backup, billing record,
analytics profile, or remote deletion endpoint.

## License and claims

The project is distributed under MIT. Public copy must not claim compliance,
certification, correctness, identity, signed provenance, or independent
adoption that the implementation and external records do not prove.
