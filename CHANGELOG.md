# Changelog

All notable changes will be documented here.

## Unreleased

### Added

- A working `fr-init` CLI with deterministic local templates.
- A provider-neutral `fr run` command that witnesses an exact argument array
  without invoking a shell or retaining stdout, stderr, or environment content.
- Immutable, content-addressed `fr seal` handoff capsules.
- `fr verify` integrity, workspace-freshness, and observed-proof outcomes.
- Public versioned handoff-capsule and command-receipt JSON Schemas, plus a
  reproducible canonical-digest contract and known vector.
- An inert Git index/raw-worktree fingerprint with normalized executable modes
  and bounded stable-snapshot checks.
- Safe retry and partial-repair behavior that preserves existing evidence.
- Versioned recorder identity with task-mismatch and malformed-state rejection.
- Stable input, target-conflict, and path-boundary errors.
- A Node test suite, package-content regression check, and CI matrix.
- Contributor, security, privacy, and troubleshooting guidance.

### Fixed

- The package now contains the executable and decision template advertised by
  its README and package metadata.
- Task names containing replacement tokens such as `$&` are written exactly to
  `resume.md`.
- Verification fails closed for malformed receipts, task-mismatched evidence,
  changing workspaces, unsafe immutable targets, and non-portable paths.
