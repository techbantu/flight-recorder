# Security Policy

## Supported versions

Until the first public release, only the latest commit on the default branch is
eligible for security fixes.

## Report a vulnerability

Do not disclose exploit details, secrets, private paths, or task artifacts in a
public issue.

Use GitHub's **Report a vulnerability** link when private vulnerability
reporting is enabled for this repository. If that link is unavailable, open a
public issue containing only the words “private security contact requested” and
wait for a maintainer-provided private channel before sharing details.

## Security boundaries

Flight Recorder's own artifacts stay inside the current working directory, are
never overwritten, and require no network request. `fr run` executes only the
explicit argument array after `--` with `shell: false`; the invoked program can
still access the network and filesystem under the user's authority. Version 1
does not impose a timeout or supervise descendant processes.

Receipts retain exact command arguments but only hashes and byte counts for
the bytes observed on stdout and stderr. Text written literally inside an
argument remains part of the retained argument. Exact arguments can include
absolute paths, usernames, URLs, and embedded tokens. Do not pass secrets on
the command line. Flight Recorder does not separately query or capture
environment variables or configured Git remotes, but values explicitly placed
in arguments or artifacts remain there. Users remain responsible for reviewing
task text, receipts, and artifact paths before committing or sharing them.

Output hashes are not encryption. Low-entropy output can be guessed and checked
against its stored hash.

Content hashes detect later changes and workspace drift. They do not prove
authorship, trusted identity, test quality, or semantic correctness, and a local
operator can construct a new internally consistent capsule.

## GitHub Action boundary

The Action executes the `argv` JSON array explicitly written into the adopting
repository's workflow. It uses spawn `shell: false`, but a maintainer can still
explicitly choose `bash`, `sh`, `cmd.exe`, PowerShell, or another interpreter
as the executable. Never construct `argv` from a pull-request title, body,
branch name, issue text, model output, or another untrusted expression.

Use ordinary read-only `pull_request` workflows without secrets. Never combine
untrusted checkout or command execution with `pull_request_target`,
`workflow_run`, repository write permission, production credentials, or
deployment secrets.

The Action applies a clean-workspace preflight, requires the complete
non-ignored snapshots before and after execution to match, and verifies the
capsule again in a fresh clone of the recorded commit. Snapshot equality does
not prove continuous immutability: a command can mutate a file and restore its
exact bytes and mode before exit. Git-ignored files remain outside the v1
fingerprint and preflight. Failure evidence remains on the runner but is not
reported as `VALID`.

As defense in depth, the child process does not directly inherit GitHub
file-command paths, `GITHUB_TOKEN`, Actions runtime tokens, or OIDC request
credentials from the Action process. This is not a same-user sandbox: hostile
code can inspect its runner, leave descendants, or tamper with its own job.
Other environment variables configured by the workflow are still inherited.
Command stdout and stderr are streamed to the ordinary GitHub Actions log,
where GitHub's visibility and retention rules apply.

Git metadata subprocesses receive a smaller allowlisted environment with no
arbitrary workflow variables. The Action rejects executable Git content
filters and initialized submodules before status runs; this also means hydrated
LFS and initialized-submodule worktrees are unsupported in v1. These checks
reduce accidental helper execution but cannot lock repository configuration
against a racing same-user process.

Optional GitHub artifact signing is a separate adopter-controlled step
requiring `id-token: write` and `attestations: write`. Put it in a separate job
that downloads the exact evidence artifact and does not check out or execute
project code. A valid signature proves the signing workflow identity and
subject digest, not the semantic quality of the command or tests. Review the
complete recorder before sharing it: task text, exact command arguments, and
user-authored artifacts can contain private data. Upload only the exact
`attestation-capsule-path` and `attestation-predicate-path` outputs, never a
directory recursively. The staged capsule still retains the task label,
recorder path, workspace fingerprint, and file summaries.
