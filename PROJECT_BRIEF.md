# Project brief

## Product

Flight Recorder is a local-first, provider-neutral CLI and GitHub Action for
detecting whether recorded engineering evidence still belongs to a specific
Git workspace.

## Users

- Primary: open-source maintainers reviewing agent-assisted work.
- Secondary: contributors and coding agents handing work between sessions.
- Blocker: repository owners responsible for CI and secret safety.

## Sharp wedge

Turn one real verification command into a tamper-evident capsule that is bound
to an unchanged Git checkout and can optionally be signed by the adopting
repository's GitHub workflow identity.

## Non-goals

- judge whether a test is meaningful or code is correct;
- prove human identity, authorship, or intent;
- record a terminal or shell automatically;
- run a command taken from a capsule;
- provide accounts, hosting, telemetry, or an AI provider;
- replace GitHub attestations, Sigstore, SLSA, or code review.

## Acceptance

- exact argv is invoked with spawn `shell: false`;
- pre-existing non-ignored dirt or a different post-command endpoint cannot
  report `VALID`;
- matching endpoint snapshots and exact clean-clone reconstruction are
  distinguished from continuous immutability;
- executable Git content filters, sparse checkouts, and initialized submodules
  fail before the Action runs its observed command;
- a success capsule passes exact local verification and an Action-performed
  clean-clone restore;
- Action output and predicate omit exact argv, task, environment, and output;
- Linux, macOS, and Windows hosted checks pass; and
- all trust and privacy limits remain public.

## Principal risks

The dangerous false inference is that a valid or signed capsule proves the
chosen test is sufficient. The dangerous execution path is running
contributor-controlled commands in a privileged workflow. Both are explicitly
refused in the product and security contracts.
