# Contributing

Flight Recorder welcomes focused improvements that keep the tool local,
portable, and easy to audit.

## Scope

Good contributions include:

- reproducible bug fixes with regression tests;
- safer no-overwrite or path behavior;
- stricter capsule integrity, freshness, and privacy behavior;
- Node.js portability fixes for macOS, Linux, or Windows;
- clearer templates and documentation that match runtime behavior.

Out of scope for the current project:

- telemetry or analytics;
- accounts, a hosted service, or an AI-provider dependency;
- automatic capture of shell history, source code, or private files;
- AI summaries, hosted accounts, task graphs, or provider-specific core logic;
- a force-overwrite mode without a separately reviewed safety design.

## Set up

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/techbantu/flight-recorder.git
cd flight-recorder
npm ci
npm run check
```

The repository has no runtime or development dependencies. Tests use Node's
built-in test runner.

## Make a change

1. Create a branch; do not push directly to the default branch.
2. Add a failing test for the behavior or regression first.
3. Make the smallest implementation change that passes it.
4. Run `npm run check` and `npm pack --dry-run`.
5. Explain intent, verification, risk, and rollback in the pull request.

Never commit real secrets, customer data, private receipts, or proprietary
project content as fixtures.

## Report a bug

Include the Node version, operating system, exact command, exit code, and
sanitized output. Replace private paths and task content before posting.

Never use a real token or secret as a command argument in a fixture: observed
receipts intentionally retain the exact argument array.
