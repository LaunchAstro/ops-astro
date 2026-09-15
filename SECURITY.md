# Security policy

## Report a vulnerability privately

Email [security@launchastro.com](mailto:security@launchastro.com) with the
reproduction steps, affected revision, and the access or effect an attacker
obtains. Do not publish sensitive details in an issue or pull request.
GitHub private vulnerability reporting is an intended second route once enabled
and tested. Mailbox delivery has not been proven in this foundation.

Nathan Mulligan is the named recipient. The policy targets acknowledgement
within three business days in Australian eastern time, followed by an
assessment and coordinated disclosure within 90 days of acknowledgement.
Reporters may request credit. There is no bounty. These are policy targets;
the repository contains no operational receipt establishing mailbox delivery.

## Supported versions

There is no released application or supported product version. Repository
workflows, configuration, scripts, and dependencies are in scope for reports.
No hosted product or installation exists as an artefact of this foundation.

## Planned product controls

These requirements are not implemented controls:

- Business isolation in database policies, composite relationships, cache keys, queues, object storage, and other derived records.
- Resource- and action-specific permissions, checked again when an effect occurs.
- A separate credential broker with catalogued operations and bounded response handling.
- Deny-by-default egress, with private network and metadata destinations denied.
- A per-run sandbox for arbitrary code, with no unsandboxed fallback.
- Decisions bound to the exact proposed action, with current authority, expiry, budget reservations, and append-only evidence.
- Protected attachments and controls for copies in prompts, outputs, checkpoints, logs, and traces.

Gates record accountability. Sandbox isolation, egress controls, broker identity,
and database roles provide containment. The
[sandbox contract](docs/adr/0048-sandbox-launcher-contract-drafted-reviewed-not-built.md)
requires Nathan's final approval before implementation.

The planned external security assessment has an early threat-model stage and
a later implementation test and retest. Relevant cases include prompt injection,
allowed-channel exfiltration, approval replay, budget races, and pooled
cross-business access. Neither stage is claimed complete.

## Repository controls and evidence

Local checks cover contamination, secrets, dependency licences, attribution,
and review-policy configuration. Hosted push protection, signed-commit
requirements, reviewer checks, and effective rulesets require separate live
verification. An absent required status remains pending and blocks merging.
[The publication checklist](docs/plan/publication-checklist.md) records those
outstanding proofs. A passing local scan is not permission to publish.
