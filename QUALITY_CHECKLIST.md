# Quality checklist

Before review:

- [ ] Exact argv success and metacharacter-inert paths pass.
- [ ] Empty, malformed, non-string, oversized, and missing inputs fail before
      command execution.
- [ ] Child failure, spawn failure, mismatched endpoint snapshots, and
      non-ignored tracked, staged, or untracked drift cannot report success.
- [ ] Pre-existing staged, unstaged, and non-ignored untracked content is
      rejected before command execution.
- [ ] The ignored-file boundary is tested and documented.
- [ ] Capsule and referenced-artifact tampering fail.
- [ ] Exact workspace drift and continued mutation fail closed.
- [ ] Predicate and step summary omit task, argv, environment, stdout, and
      stderr.
- [ ] GitHub file-command, runtime-token, and OIDC variables do not reach the
      child process; command output retention in workflow logs is documented.
- [ ] Raw capsule digest is distinct from and consistent with the internal
      canonical content digest.
- [ ] Evidence restores and verifies in a clean clone of the recorded HEAD.
- [ ] Public artifact examples upload only the two exact staged file outputs
      and never recursively upload either staging directory or mutable recorder.
- [ ] Attestation verification pins signer workflow, source ref/digest, hosted
      runner, exact subject count, schema, and digest relationships.
- [ ] Package contents include every advertised executable, Action file,
      schema, template, and contract.
- [ ] Linux Node 20/22/24, macOS Node 22, and Windows Node 22 hosted checks
      pass.
- [ ] Strict Claude plugin validation passes without adding hooks or broad
      permissions.
- [ ] Secret scan and diff-whitespace checks pass.
- [ ] Public docs state the product's trust, privacy, platform, ignored-file,
      timeout, content-filter, and initialized-submodule limits.
