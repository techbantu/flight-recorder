# Handoff Interchange Contract v1

This document defines the reproducible parts of Flight Recorder handoff capsule
version 1. The packaged schemas are:

- `schema/handoff-v1.schema.json`
- `schema/command-receipt-v1.schema.json`

Their stable identifiers are
`urn:techbantu:flight-recorder:schema:handoff:v1` and
`urn:techbantu:flight-recorder:schema:command-receipt:v1`. The packaged files,
not a mutable web page, are the authoritative schema resources.

## Shared value contracts

A portable relative path is a non-empty `/`-separated path. It has no empty,
`.` or `..` segment, backslash, colon, ASCII control character, leading slash,
or trailing slash. A task is a non-whitespace string of at most 200 Unicode
code points with no ASCII control character.

Byte counts are non-negative safe integers. SHA-256 values use 64 lowercase
hexadecimal characters. Regular workspace modes are normalized to `100644` or
`100755`: on POSIX, any executable bit produces `100755`; on Windows, raw
untracked and worktree files use `100644` because Windows does not expose a
portable POSIX executable bit. Git index modes remain in the hashed index
entry list.

## Capsule content digest

To reproduce `contentDigest`:

1. Parse the capsule as JSON and remove the top-level `contentDigest` member.
2. Accept only JSON data: objects, arrays, strings, finite JSON numbers,
   booleans, and null.
3. Recursively sort object member names by raw UTF-16 code-unit order. Preserve
   array order.
4. Serialize using ECMAScript `JSON.stringify` string escaping and number
   rendering. There is no Unicode normalization, insignificant whitespace,
   byte-order mark, or trailing newline. In particular, negative zero is
   serialized as `0`.
5. Encode that canonical string as UTF-8 and hash those bytes with SHA-256.
6. Store `sha256:<lowercase-hex>` in `contentDigest` and address the file as
   `sha256-<lowercase-hex>.json`.

This is a Flight Recorder canonicalization contract, not a claim of RFC 8785
conformance.

Known vector:

```text
Input:     {"z":[3,{"β":"line\n","a":true}],"a":"π"}
Canonical: {"a":"π","z":[3,{"a":true,"β":"line\n"}]}
SHA-256:   d0f47fc89494118614fb87e455d261df890212a0afdcc4e65c0c124b84828143
```

## Workspace fingerprint

The recorder directory is excluded from the workspace fingerprint; its four
required artifacts and referenced receipt files are hashed separately.

The v1 Git fingerprint is intentionally inert. It does not run `git diff`.
Flight Recorder clears inherited `GIT_*` settings, ignores system and global
Git configuration, disables fsmonitor and untracked-cache integration, and
uses only:

- `git rev-parse --verify HEAD`;
- `git ls-files --stage -z` for index mode, object ID, stage, and path;
- `git ls-files --others --exclude-standard -z` for repository-nonignored
  untracked paths, with the user's global excludes file disabled.

It never invokes diff or clean filters, textconv drivers, or repository hooks.
The `index` digest hashes the canonical index-entry list. The `worktree` digest
hashes actual bytes and normalized modes for tracked regular files, link text
for tracked symbolic links, and explicit missing-file states. Untracked regular
files are listed with path, byte count, SHA-256, and normalized mode.
Git-ignored files are outside v1.

For gitlinks, the index object IDs and the initialized checkout's HEAD are
hashed. Uninitialized and missing checkouts are distinct. Dirty, ignored, or
untracked content inside a submodule is not recursively hashed in v1.

A capture checks each file's identity before and after reading and checks HEAD,
the index listing, and the untracked listing before and after assembly. It then
requires two consecutive identical full captures, with at most four captures.
Continued mutation fails with `E_WORKSPACE_UNSTABLE`. This reduces composite
read races; it is not a transactional filesystem lock, so a mutation can still
begin after the accepted snapshot.

## Supporting command receipts

`fr run` invokes the exact argument array with `shell: false`. It streams
stdout and stderr to the current terminal and retains only their byte counts
and SHA-256 hashes. It does not separately capture environment variables or
configured Git remotes. It does retain every argument exactly, including
absolute paths, usernames, URLs, or embedded tokens supplied by the operator.

Version 1 has no built-in timeout and is not a process supervisor. The invoked
command must terminate on its own or be managed by the operator.

A schema-valid command receipt supports `VALID` only when all of these are
true:

- the receipt's `task` exactly equals the capsule and current recorder task;
- its result has exactly the schema-defined fields;
- `exitCode` is `0`, `timedOut` is `false`, `signal` is null, and
  `spawnErrorCode` is null;
- `workspaceAfter` exactly equals the capsule workspace fingerprint;
- the receipt file's path, byte count, and SHA-256 match its capsule summary.

An otherwise intact and current capsule without such a receipt is
`UNVERIFIED`.

## Trust and privacy limits

Hashes provide integrity, equality, and workspace-freshness signals. They are
not encryption. Low-entropy output can be guessed and compared against a
stored hash. A capsule does not prove authorship, operator identity, test
quality, semantic correctness, or independent execution; a local operator can
fabricate new internally consistent evidence.
