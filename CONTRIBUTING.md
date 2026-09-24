# Contributing

Issues are open, as information. Anyone may open one and it is read as a
report, not as a request for work. Unsolicited pull requests are closed: the
build loop below routes every change through a ticket, and a change arriving
outside it has no ticket to be reviewed against. The publication checklist
must verify those hosted settings. This document does not claim that hosted
restrictions already exist.

## Follow the build loop

The Matt Pocock workflow in [AGENTS.md](AGENTS.md) is the sole router.

1. Resolve open requirements and record the specification.
2. Confirm the seams and break the specification into reviewable tickets.
3. Implement one ticket in an isolated worktree and ticket branch. Write meaningful tests at the agreed boundaries.
4. Review the actual revision against both the specification and repository standards. A frontier model from a different company than the builder's performs the adversarial review.
5. Obtain Copilot review on the hosted revision and resolve each finding with evidence or a recorded reason.
6. Run the required checks against the final revision. An agent invokes the merge on Nathan's credential once every one of them is green, and notifies him after. The decisions reserved below stay his.
7. Complete the final verify ticket against the integrated feature.

Small work starts at implementation. The first full loop must be rehearsed
on a throwaway feature before product code begins. That rehearsal included
hosted checks, a merge Nathan invoked himself, and a retained CI-checked
verify command. Local foundation checks do not complete that rehearsal.

The [review checkpoint](docs/agents/review-checkpoint.md) binds review to the
complete change. Authorised local foundation work with commits held uses the
actual files, diff, and manifest. It creates no commit or pull request.

## Required reviews and the merge decision

Security review runs before a pull request touching auth, tenancy, tool
execution, egress, custody, or the audit chain. Use `/security-review`, or
[the runtime-neutral procedure](.claude/skills/_shared/security-review.md).

### Who invokes the merge

From the first product pull request after this governance change, an agent
invokes the merge. It runs on Nathan's credential, because his is the only
account with push access. The rule it obeys carries no discretion: every
required check green on the head being merged, or it does not merge. After
merging it notifies Nathan, naming the pull request and the merged revision.
That notification records what happened; it does not ask permission.

These stay Nathan's own decision, and no green check releases any of them:

- the production deploy;
- the five protected parts, T1a, T1d1, T1d2, T1e, and T1i;
- a coherence waiver on the size cap;
- a reduction of any check's tier;
- the sandbox's final contract, approved before implementation.

This governance change is itself human-merged, and so is any change whose
merge waits on a protected component's conformance proof.

### The seven questions

Whoever invokes the merge answers these first:

1. Does the change meet the ticket and acceptance criteria?
2. Are the required checks green for this revision?
3. Is the required evidence present?
4. Did the cross-vendor reviewer and Copilot each review the revision being
   merged, and is every finding from both closed? Answer no if either review
   is missing or bound to an earlier revision. No findings is not the same as
   no review.
5. Did the required security review run?
6. Is the change under the size cap or covered by a valid waiver?
7. Which layer should have caught each finding, and what check now covers it?

The review-evidence check reads question four's answer out of the pull
request body. It proves that the answer is bound to this exact head, and
nothing further: it reads no reviewer identity, so a green `review evidence
for this revision` does not establish that any reviewer read anything.

It reads each code-review and security-review line as one outcome. A line
holding `not`, `never`, `no`, `cannot`, `isn't`, `wasn't` or `aren't`
anywhere is a rejection, unless the `no` belongs to `no findings` (or no
issues, problems, blockers or concerns). A line that counts findings fails
when any count closed is lower than a count raised, across sentences too:
`2 findings. 1 closed` fails and `2 findings. 2 closed` passes. Reword
a clean outcome rather than negate part of it.

GitHub's _update branch_ button writes a merge commit carrying no trailers,
which fails `commit messages and provenance`. Because
`strict_required_status_checks_policy` is on, a branch must be up to date
with its base before it can merge, so do that update locally and push it.

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
