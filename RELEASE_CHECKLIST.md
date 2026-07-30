# Release checklist

No green pull request, local test, or draft tag publishes Flight Recorder.

Before an approved release:

- [ ] Confirm target version is absent from npm and GitHub Releases.
- [ ] Update package, lockfile, plugin manifest, and changelog versions
      together.
- [ ] Complete every item in `QUALITY_CHECKLIST.md`.
- [ ] Inspect and smoke-test the packed artifact from a clean project.
- [ ] Validate real receipt, capsule, and CI predicate examples with an
      independent JSON Schema Draft 2020-12 implementation.
- [ ] Confirm the Action stages only `capsule.json` and `predicate.json`, and
      examples upload those exact file outputs and verify both raw digests.
- [ ] Confirm the Action rejects executable Git content filters, sparse
      checkouts, and initialized submodules before the observed command.
- [ ] Confirm the attestation policy rejects extra subjects, zero or multiple
      receipt summaries, wrong types, or digest drift.
- [ ] Verify default-branch hosted CI.
- [ ] Confirm private vulnerability reporting and support paths.
- [ ] Pin public Action examples to the immutable release commit.
- [ ] Test a real external-style checkout using that full commit pin.
- [ ] Obtain explicit approval separately for merge, tag, npm publish, GitHub
      Release, plugin listing, and any public attestation.

Rollback:

- Deprecate a defective npm version with a precise warning.
- Publish a corrected patch only after the complete gate.
- Tell Action consumers to update their immutable commit pin.
- Never move a tag or silently replace published evidence.

See `docs/RELEASING.md` for the executable procedure.
