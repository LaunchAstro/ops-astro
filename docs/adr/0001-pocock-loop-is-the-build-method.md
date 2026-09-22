# One build workflow

Accepted 6 September 2026; consolidated for the public foundation on
8 September. **Amended 11 September 2026**: the independent reviewer must be
a frontier model from a different company, stated here consistently with the
other records that carry the rule.

The Matt Pocock specification, ticket, implementation, review, and verification
workflow is the sole repository router. Pstack contributes selected standards
inside that workflow. A second orchestration or task-management process would
split ownership and make review harder to reproduce.

One owner works on one ticket in an isolated worktree and branch. The final
ticket verifies the integrated feature. Review covers both the specification
and repository standards. The independent reviewer must be a frontier model
from a different company than the builder's, because same-vendor models share
blind spots.
Copilot reviews the hosted revision. An agent then invokes the merge on
Nathan's credential once every required check is green, and notifies him;
what stays his decision is listed in [Contributing](../../CONTRIBUTING.md).

Before product code begins, rehearse the complete loop on a throwaway feature,
including security review, hosted checks, a human merge, and the verify ticket.
Retain a verify command that CI runs. Foundation tooling checks alone do not
complete this rehearsal.

Development context comes from the repository, specification, ticket, and
current evidence. Operational product records remain persistent. See
[model roles](../agents/model-roles.md) and [Contributing](../../CONTRIBUTING.md).
