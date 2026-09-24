# Merge commits after checks and reviews

Accepted 6 September 2026; seven-question checklist confirmed 7 September.
**Amended 10 September 2026**: the before-merge hold named here is the
affected component's conformance proof, which replaced the withdrawn engineer
gate, per
[ADR 0049](0049-senior-engineer-signed-engagement-stop-authority.md).
**Amended 23 September 2026**: the merge is invoked by an agent rather than
by a person, from the first product pull request after the governance change
that carried this amendment.

Use merge commits only. Disable squash, rebase merge, linear history, and
all automatic merging. Preserve reviewed signed commits and require that the
merge be invoked, by a named actor, after every required check and review
passes.

**Who invokes it, and on what.** An agent invokes the merge on Nathan's
credential, because his is the only account with push access. Its rule is
every required check green on the head being merged, and it has no discretion
beyond that rule. It notifies him after the merge, naming the pull request
and the merged revision. Disabling automatic merging keeps this an invoked act
with an actor who can be asked what they did. It does not mean a person
presses the button.

**What is not reachable by a green check**, and stays Nathan's own decision:
the production deploy, the five protected parts (T1a, T1d1, T1d2, T1e, T1i),
a coherence waiver on the size cap, a reduction of any check's tier, and the
sandbox's final contract. The governance change carrying this amendment is
itself human-merged.

Separate the non-bypassable main protections from any solo-maintainer exemption
for a human approving-review requirement. The exemption must not bypass a pull
request, signatures, required checks, independent model review, Copilot, or
an applicable conformance proof. [The ruleset procedure](../plan/ruleset.md)
defines the intended configuration and live acceptance cases.

A missing required status remains pending and blocks merging. Required names
and originating apps must come from actual hosted runs. Local scripts and
configuration do not prove hosted enforcement or that a review actually ran.

The human checklist has seven questions, defined in
[Contributing](../../CONTRIBUTING.md). A green conformance proof for each
protected component that a change affects is a separate before-merge hold.
The intended initial foundation and later coherent local demo do not waive
size limits, signatures, or review.
The exact initial-upload procedure requires separate approval and must state
how the initial candidate receives review before normal hosted PR controls
can apply.
