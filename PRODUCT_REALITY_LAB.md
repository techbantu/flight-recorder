# Product reality lab

## Verdict

Test first. The deterministic Action is worth building only as the smallest
experiment for whether independent maintainers retain evidence-bound checks.
A full hosted platform, dashboard, or agent ecosystem is rejected.

## User and trigger

The exact user is an OSS maintainer receiving agent-assisted pull requests.
The trigger is a local “tests passed” claim that may no longer correspond to
the reviewed source. The current workaround is to trust prose or rerun checks
without a portable producer-side evidence object.

## Buyer map

There is no buyer: the project is free and MIT-licensed. The maintainer is the
user and champion; the security owner is the blocker; contributors and coding
agents produce the evidence.

## Experiment

Offer a five-minute, read-only, full-SHA-pinned Action to at most 15
permission-based independent maintainers with a demonstrated reproducibility
or verification need.

Success:

- five independent non-fork repositories across at least three unrelated
  owners merge real integrations;
- three remain active for 30 days with at least three meaningful runs each;
- two maintainers explain publicly why they retained it; and
- at least one real stale-evidence problem is caught without a serious privacy
  or false-positive incident.

Kill or shrink:

- fewer than three independent integrations merge;
- more than 30 percent remove or disable it;
- unexpected failures exceed 5 percent;
- maintainers say it does not affect review decisions; or
- any material secret or privacy incident occurs.

Simulation and internal dogfooding are hypotheses, not adoption evidence.
Controlled repositories, forks, demo installs, paid installs, reciprocal
arrangements, downloads, and stars are excluded from the result.
