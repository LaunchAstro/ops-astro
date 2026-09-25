# Security policy

## Report a vulnerability privately

**No private reporting route is proven yet, so this policy names none.** A
route is described here only once it has been used end to end and the
delivery confirmed. Two are intended: a security mailbox, and GitHub private
vulnerability reporting. Neither has been proved, and GitHub private
vulnerability reporting is disabled on this repository today.

Until one of them is recorded here, do not publish reproduction steps,
affected revisions, or attacker effect in an issue, a pull request, or any
other public place. Open an issue saying only that you have a security report
and no more, and wait for a private channel to be offered.

Nathan Mulligan is the intended recipient. The policy targets acknowledgement
within three business days in Australian eastern time, followed by an
assessment and coordinated disclosure within 90 days of acknowledgement.
Reporters may request credit. There is no bounty. Those targets describe the
intended handling of a report. They cannot begin before a proven route
exists, and the repository holds no receipt establishing one.

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
