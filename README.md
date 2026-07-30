# Flight Recorder

Flight Recorder is a small, local-first CLI for durable, self-checking handoffs
between humans and coding agents. It keeps current state, decisions, next
actions, verification checks, and observed command receipts together.

Use it when work crosses an agent, chat, or human boundary and you need to
detect whether a passing check still belongs to the current Git workspace—or
whether the recorded evidence changed afterward.

The core CLI does not record your terminal automatically, call an AI provider,
upload files, or decide that a successful command proves semantic correctness.

> **Release status:** the source is a tested release candidate. The
> `@techbantu/flight-recorder` package is not currently published on npm.

## Proof-carrying CI checks

The repository also contains a dependency-free GitHub Action for turning one
existing verification command into a Git-bound evidence bundle:

```yaml
- name: Test with Flight Recorder evidence
  id: evidence
  uses: techbantu/flight-recorder@<FULL_RELEASE_COMMIT_SHA>
  with:
    task: Verify the reviewed checkout
    argv: '["npm","test"]'
```

The Action runs the exact JSON argument array with spawn `shell: false`,
applies a clean-workspace preflight, requires the complete non-ignored
workspace snapshots before and after execution to match, seals the result, and
reports success only when exact `fr verify` returns `VALID` locally and in a
fresh clone of the recorded commit. This proves endpoint equality and
reconstructibility, not continuous immutability while the command runs. Its
evidence logic makes no network request and needs no GitHub token or write
permission; the chosen verification command can still use the runner's network
and filesystem. The v1 Action fails closed for executable Git content filters,
hydrated LFS, sparse checkouts, and initialized submodules.

On a trusted default-branch workflow, the adopting repository can sign the
capsule as the attestation subject and embed the limited-field predicate with
GitHub's official artifact attestation service in a separate signing job. The
example first validates the raw digests of both downloaded input files. The
signature establishes which repository and workflow signed the capsule; it
does not prove the test was well-designed, the producer process was
trustworthy, or the code is correct. The capsule retains the task label.

Use a full reviewed commit SHA, never the placeholder, a branch name, or a
movable tag. See [CI verification and attestation v1](docs/CI_ATTESTATION_V1.md)
for read-only PR and signed default-branch examples, security boundaries,
verification, and removal. Public external use is recorded under the strict,
non-telemetric rules in [Public adoption evidence](ADOPTION.md).

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

## Claude Code plugin (opt-in)

The repository also contains a minimal Claude Code plugin adapter. The adapter
defines no load-time hook or command and contains no code that invokes Flight
Recorder, starts a background process, transmits telemetry, or changes the
project working tree. It exposes one manually invoked skill that instructs
Claude to call the same local `fr-init` executable:

```bash
claude --plugin-dir .
```

Then, inside Claude Code:

```text
/flight-recorder:init Fix share previews
```

The skill instructions require an explicit task, tell Claude to pass it as one
safely quoted argument, and tell Claude not to choose a custom output directory
or invoke `fr run`, `fr seal`, or `fr verify`. These are model instructions,
not a deterministic restriction on the underlying CLI. The adapter resolves
the bundled `bin/fr-init.js` through Claude's `CLAUDE_PLUGIN_ROOT`; it does not
depend on an npm-generated alias or global install, and nothing runs
automatically.

This checkout has not been submitted to or accepted by Anthropic's plugin
directory. The core CLI remains provider-neutral and works without Claude Code.

## Choose a directory

The default is `ops/<task-slug>` inside the current working directory. To choose
another contained path:

```bash
node bin/fr-init.js "Audit release evidence" --dir .flight-recorder/release-audit
```

Run `node bin/fr-init.js --help` for the complete CLI usage.

## Record and seal a handoff

`fr run`, `fr seal`, and `fr verify` require a Git working tree with an
existing HEAD commit. `fr-init` can still initialize a recorder without Git.

Run a verification command through Flight Recorder. Arguments after `--` are
passed directly to the executable without a shell:

```bash
node bin/fr.js run ops/fix-share-previews -- npm test
```

The command's stdout and stderr still appear in the terminal. The immutable
receipt stores the exact argument array, exit status, timing, byte counts, and
SHA-256 hashes, but does not separately retain the observed output bytes or
environment. Because exact arguments are retained, output text written
literally inside an argument remains part of that argument.

On Windows, `.cmd` programs require an explicit command interpreter when
`shell: false` is used. Invoke npm transparently as the exact `cmd.exe`
argument array:

```powershell
node bin/fr.js run ops/fix-share-previews -- cmd.exe /d /s /c "npm test"
```

Version 1 does not impose a timeout or supervise descendant processes. The
observed command must terminate on its own or be managed by the operator.

Seal the current handoff:

```bash
node bin/fr.js seal ops/fix-share-previews
```

Expected output:

```text
SEALED ops/fix-share-previews/capsules/sha256-<digest>.json
```

Verify the printed capsule before resuming:

```bash
node bin/fr.js verify \
  ops/fix-share-previews/capsules/sha256-<digest>.json
```

`fr verify` reports exactly one outcome:

- `VALID`: capsule and referenced files are intact, the Git workspace is
  current, and at least one successful observed command matches that workspace.
- `STALE_WORKSPACE`: the capsule is intact, but HEAD, the Git index, raw
  tracked worktree bytes or modes, non-ignored untracked files or modes, or
  recorded submodule commit/presence differs.
- `TAMPERED`: the content-addressed capsule or a referenced artifact changed.
- `INVALID`: the schema or a required safe path is malformed or unsupported.
- `UNVERIFIED`: the capsule is current but has no successful observed command
  for that exact workspace.

Exit codes are 0, 4, 5, 6, and 3 respectively. The public interchange contract,
canonical digest algorithm, workspace model, and strict receipt semantics are
documented in [Handoff Interchange Contract v1](docs/HANDOFF_V1.md). Its
packaged schemas are [handoff-v1.schema.json](schema/handoff-v1.schema.json)
and
[command-receipt-v1.schema.json](schema/command-receipt-v1.schema.json).

A minimal drift proof is:

```text
verify the sealed capsule     -> VALID
edit any tracked source file  -> workspace changes
verify the same capsule again -> STALE_WORKSPACE
```

The recorder directory is excluded from the Git workspace fingerprint because
its artifacts and receipts are hashed separately. Git-ignored files are not
part of the fingerprint. Fingerprinting reads inert Git index metadata and raw
filesystem bytes; it does not execute diff/textconv drivers, clean filters,
fsmonitor hooks, or repository hooks. The v1 submodule summary records gitlink
index state and checkout HEAD/presence, but does not recursively hash dirty,
ignored, or untracked files inside a submodule.

## Safety contract

- Existing artifacts are never overwritten.
- A retry preserves edits and creates only missing artifacts when the existing
  schema and task identity match.
- `state.json` carries schema version 1 and binds the directory to one exact
  task name, preventing slug collisions from mixing two tasks.
- An unrelated or malformed non-empty target is rejected before any write.
- A file/directory type conflict is rejected before any write.
- `--dir` cannot escape the current working directory.
- There is no `--force` mode.
- Flight Recorder itself has no runtime dependencies, telemetry, account, or
  network call; an explicitly invoked command may use the network.
- Receipts and capsules are published with atomic, exclusive filesystem writes.
- Recorder, capsule, and receipt paths cannot traverse symbolic links.
- `fr run` invokes an explicit argument array with `shell: false`.
- Workspace snapshots require per-file stability and two consecutive matching
  captures; continued mutation fails closed.

If creation stops because of a local filesystem error, correct the permission or
path problem and run the same command again. The retry is additive and keeps
artifacts that were already created.

If the CLI reports `E_STATE_SCHEMA`, `E_STATE_INVALID`, or `E_TASK_MISMATCH`, it
will not repair that directory automatically. Review its existing contents and
use a different `--dir`; do not delete evidence merely to bypass the check.

## Working protocol

1. Keep `state.json` limited to facts that are true now.
2. Append meaningful choices to `decisions.log`.
3. Put the exact success and rejection checks in `checks.md`.
4. Save concrete evidence under `receipts/`.
5. End each work session by updating the next actions in `resume.md`.

Flight Recorder validates capsule integrity, workspace freshness, and whether
it directly observed a successful process exit. It cannot validate that a test
was well-designed or that a claim is semantically correct.

## Privacy

The CLI reads its bundled templates and writes the task name and artifacts to
the path you choose. It does not transmit or retain a second copy. Artifacts may
contain private project information because you write them; review them before
committing or sharing. Export is a normal file copy, and deletion is a normal
local file deletion.

Installing from npm or cloning from GitHub uses those services, but running
`fr-init` does not.

Invoking `/flight-recorder:init` is a Claude Code interaction: Claude processes
the supplied task text under the user's configured Claude Code service and data
terms. Run `fr-init` directly for the provider-neutral, local-only path.

`fr run` records the exact executable and argument array. That array may retain
absolute paths, usernames, URLs, or embedded tokens, so do not place passwords,
tokens, or private content on the command line. Flight Recorder does not query
or separately capture configured Git remotes, but a remote URL explicitly
present in an argument or artifact remains there. Output content and
environment variables are not stored by default; exact arguments are stored,
and terminal software or the invoked command may log output independently.

Output hashes are integrity and equality signals, not encryption. Someone can
guess low-entropy output and compare its hash with a receipt.

SHA-256 addresses establish self-consistency and detect later local changes.
They do not establish authorship, trusted identity, or independent attestation.
A local operator can fabricate evidence and recompute a new internally
consistent capsule. Reviewers must still judge the command, the test, and the
operator's authority.

## Development

```bash
npm ci
npm run check
npm pack --dry-run
npm run plugin:validate
```

`npm run check` performs syntax checks and the Node test suite. The tests cover
creation, safe retry and repair, recorder identity and task collisions,
conflict rejection, literal task rendering, exact argument execution, output
minimization, canonical content addressing, inert and stable workspace
fingerprinting, strict receipt proof, integrity and freshness outcomes, invalid
input, path containment, and package contents.

Plugin validation is a separate maintainer check because ordinary contributors
and CI environments may not have Claude Code installed.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change.

## Support and security

Use GitHub Issues for reproducible, non-sensitive bugs after the repository is
unarchived. Do not put secrets, private receipts, or exploit details in a public
issue. See [SECURITY.md](SECURITY.md) for the private-reporting rule.

## License

[MIT](LICENSE)
