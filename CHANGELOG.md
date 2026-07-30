# Changelog

All notable changes will be documented here.

## Unreleased

### Added

- A working `fr-init` CLI with deterministic local templates.
- An explicit-only Claude Code plugin adapter for local `fr-init` setup, with
  no hooks, agents, MCP servers, telemetry, or automatic invocation.
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
- A dependency-free GitHub Action that runs a bounded JSON argument array,
  requires commit-reconstructible endpoint snapshots, rejects non-ignored
  endpoint drift, rejects executable Git filters and initialized submodules,
  strips sensitive GitHub controls from child and metadata subprocesses, emits
  a verified capsule, and prepares two exact privacy-reduced files plus a
  limited-field custom predicate for optional GitHub attestation.
- A public CI-verification predicate schema, signed-evidence workflow guidance,
  clean-clone restoration proof, and explicit external-adoption ledger.
- Contributor, security, privacy, and troubleshooting guidance.

### Fixed

- The package now contains the executable and decision template advertised by
  its README and package metadata.
- Task names containing replacement tokens such as `$&` are written exactly to
  `resume.md`.
- Verification fails closed for malformed receipts, task-mismatched evidence,
  changing workspaces, unsafe immutable targets, and non-portable paths.
- The Action attestation policy binds exactly one receipt summary and rejects
  non-string digest fields, extra receipt summaries, or digest drift.
