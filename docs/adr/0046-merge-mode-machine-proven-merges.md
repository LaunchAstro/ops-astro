# Merge commits after checks and reviews

Accepted 6 September 2026; seven-question checklist confirmed 7 September.
**Amended 10 September 2026**: the before-merge hold named here is the
affected component's conformance proof, which replaced the withdrawn engineer
gate, per
[ADR 0049](0049-senior-engineer-signed-engagement-stop-authority.md).

Use merge commits only. Disable squash, rebase merge, linear history, and
all automatic merging. Preserve reviewed signed commits and require a human
merge decision after every required check and review passes.

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
