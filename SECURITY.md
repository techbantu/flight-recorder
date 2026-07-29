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
