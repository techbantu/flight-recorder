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

Flight Recorder writes only inside the current working directory, never
overwrites an existing artifact, and makes no network request of its own.
`fr run` executes only the explicit argument array after `--` with
`shell: false`; the invoked program can still access the network and filesystem
under the user's authority.

Receipts retain exact command arguments but only hashes and byte counts for
the bytes observed on stdout and stderr. Text written literally inside an
argument remains part of the retained argument. Do not pass secrets on the
command line. Capsules exclude environment variables and Git remote URLs. Users
remain responsible for reviewing task text and artifact paths before committing
or sharing them.

Content hashes detect later changes and workspace drift. They do not prove
authorship, trusted identity, test quality, or semantic correctness, and a local
operator can construct a new internally consistent capsule.
