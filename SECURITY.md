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

`fr-init` writes only inside the current working directory, never overwrites an
existing artifact, and makes no runtime network request. Users remain
responsible for reviewing task artifacts before committing or sharing them.
