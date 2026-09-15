# Contributing

Outside contributions remain closed. Issue and pull request creation are
intended to be restricted to collaborators when the repository is hosted.
The publication checklist must verify those settings. This document does not
claim that hosted restrictions already exist.

## Follow the build loop

The Matt Pocock workflow in [AGENTS.md](AGENTS.md) is the sole router.

1. Resolve open requirements and record the specification.
2. Confirm the seams and break the specification into reviewable tickets.
3. Implement one ticket in an isolated worktree and ticket branch. Write meaningful tests at the agreed boundaries.
4. Review the actual revision against both the specification and repository standards. A frontier model from a different company than the builder's performs the adversarial review.
5. Obtain Copilot review on the hosted revision and resolve each finding with evidence or a recorded reason.
6. Run the required checks against the final revision. Nathan decides whether to merge.
7. Complete the final verify ticket against the integrated feature.

Small work starts at implementation. The first full loop must be rehearsed
on a throwaway feature before product code begins. The rehearsal includes
hosted checks, the human merge decision, and a retained CI-checked verify
command. Local foundation checks do not complete that rehearsal.

The [review checkpoint](docs/agents/review-checkpoint.md) binds review to the
complete change. Authorised local foundation work with commits held uses the
actual files, diff, and manifest. It creates no commit or pull request.

## Required reviews and merge decision

Security review runs before a pull request touching auth, tenancy, tool
execution, egress, custody, or the audit chain. Use `/security-review`, or
[the runtime-neutral procedure](.claude/skills/_shared/security-review.md).

Nathan answers seven questions before merging:

1. Does the change meet the ticket and acceptance criteria?
2. Are the required checks green for this revision?
3. Is the required evidence present?
4. Are the review findings closed?
5. Did the required security review run?
6. Is the change under the size cap or covered by a valid waiver?
7. Which layer should have caught each finding, and what check now covers it?

A conformance proof is a separate condition. For changes to the domain
model, tenancy wrapper, queue and delivery contracts, gate engine, credential
broker, egress control, sandbox launcher, or migration system, that
component's conformance test must be green **before merge**, as a required
check. No test, no merge, whatever the review says.

The sandbox also requires Nathan's approval of its **final contract before
implementation**, after adversarial findings are resolved. Model review and
Copilot do not replace either hold.

[The ruleset procedure](docs/plan/ruleset.md) defines the intended hosted
controls. Merge commits only, linear history off, squash off, rebase-merge off,
and no automatic merges. Nobody bypasses required checks or signatures.
Hosted enforcement remains unproven until tested with the actual credentials.

## Attribute and sign work

Every agent-assisted commit carries truthful `Assisted-by: LLM`,
`Agent-model:`, and `Agent-tool:` trailers. The session supplies the actual
model and tool. Every human-only commit carries that human's `Signed-off-by`.
Agents never create a human sign-off. See [AI policy](AI_POLICY.md).

All project commits require cryptographic signatures. The DCO app's intended
organisation-member exemption is separate from provenance requirements.
Outside contributors must personally certify the
[Developer Certificate of Origin](https://developercertificate.org/) and
complete the contributor agreement when contributions open. The CLA is
currently a draft and no signing service is active.

## Keep changes reviewable

The size checker allows up to 400 changed lines and warns from 300. A recorded
reason is required for either waiver: `size-waiver-mechanical` for mechanical
changes, or `size-waiver-coherence` for a change that must be reviewed together.
The maintainer decides a coherence waiver. One file may not contain more
than 400 hand-written changed lines in a pull request. Split work names the
invariant test that verifies the integrated result.

Use synthetic fixtures. Retain third-party licences and attribution. Presets
are data only, as the [preset boundary](docs/licensing/preset-boundary.md)
defines. The [code of conduct](CODE_OF_CONDUCT.md) applies to everyone.
Report vulnerabilities through [Security](SECURITY.md).
