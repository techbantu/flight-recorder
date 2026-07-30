# Project rules

Flight Recorder is a deterministic evidence tool. Runtime truth, public
schemas, documentation, tests, and examples must remain aligned.

- Preserve exact argument boundaries and spawn `shell: false`.
- Never add telemetry, accounts, provider calls, automatic shell capture, or
  background execution to the core.
- Treat task text, paths, receipts, capsules, and Action inputs as untrusted.
- Do not print exact command arguments or user-authored artifacts into public
  summaries.
- Fail closed on malformed, moving, stale, or tampered evidence.
- State explicitly that hashes do not prove correctness, authorship, identity,
  secrecy, or test quality.
- Add the smallest adversarial regression test before fixing or extending a
  contract.
- Run `npm run check`, `npm pack --dry-run`, and the relevant clean-package or
  plugin proof before calling a change review-ready.
- Never merge, tag, publish, submit, or move a release reference without
  explicit maintainer approval.
