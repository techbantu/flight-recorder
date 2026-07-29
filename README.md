# Flight Recorder

Flight Recorder is a small, local-first CLI that creates a durable handoff for
an interrupted development task. It gives a human or coding agent one place to
find current state, decisions, next actions, verification checks, and receipts.

It does not record your terminal, call an AI provider, upload files, or decide
that work is complete.

> **Release status:** the source is a tested release candidate. The
> `@techbantu/flight-recorder` package is not currently published on npm.

## Why use it?

Long-running work often survives in chat history or memory alone. When that
context is compacted, interrupted, or handed off, the next operator must guess
what is true. Flight Recorder initializes a consistent, inspectable record in
seconds:

```text
ops/fix-share-previews/
├── state.json       # current task state
├── decisions.log    # consequential choices and evidence
├── checks.md        # what must be verified
├── resume.md        # deterministic next actions
└── receipts/        # test output, diffs, screenshots, or links
```

## Try it from a checkout

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/techbantu/flight-recorder.git
cd flight-recorder
npm ci
node bin/fr-init.js "Fix share previews"
```

Expected output:

```text
Created flight recorder at ops/fix-share-previews
Created: state.json, decisions.log, checks.md, resume.md, receipts/
```

After a public npm release is visible, the equivalent package command will be:

```bash
npx --package @techbantu/flight-recorder fr-init "Fix share previews"
```

Do not use that npm command until the package exists in the registry.

## Choose a directory

The default is `ops/<task-slug>` inside the current working directory. To choose
another contained path:

```bash
node bin/fr-init.js "Audit release evidence" --dir .flight-recorder/release-audit
```

Run `node bin/fr-init.js --help` for the complete CLI usage.

## Safety contract

- Existing artifacts are never overwritten.
- A retry preserves edits and creates only missing artifacts.
- An unrelated non-empty target is rejected before any write.
- A file/directory type conflict is rejected before any write.
- `--dir` cannot escape the current working directory.
- There is no `--force` mode.
- The CLI has no runtime dependencies, telemetry, account, or network call.

If creation stops because of a local filesystem error, correct the permission or
path problem and run the same command again. The retry is additive and keeps
artifacts that were already created.

## Working protocol

1. Keep `state.json` limited to facts that are true now.
2. Append meaningful choices to `decisions.log`.
3. Put the exact success and rejection checks in `checks.md`.
4. Save concrete evidence under `receipts/`.
5. End each work session by updating the next actions in `resume.md`.

Flight Recorder does not validate whether a receipt proves a claim. That
judgment remains with the operator and reviewer.

## Privacy

The CLI reads its bundled templates and writes the task name and artifacts to
the path you choose. It does not transmit or retain a second copy. Artifacts may
contain private project information because you write them; review them before
committing or sharing. Export is a normal file copy, and deletion is a normal
local file deletion.

Installing from npm or cloning from GitHub uses those services, but running
`fr-init` does not.

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

`npm run check` performs syntax checks and the Node test suite. The tests cover
creation, safe retry and repair, conflict rejection, invalid input, path
containment, and package contents.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change.

## Support and security

Use GitHub Issues for reproducible, non-sensitive bugs after the repository is
unarchived. Do not put secrets, private receipts, or exploit details in a public
issue. See [SECURITY.md](SECURITY.md) for the private-reporting rule.

## License

[MIT](LICENSE)
