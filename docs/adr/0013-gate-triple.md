# One task and gate contract

Accepted 6 September 2026; amended by C05 to C09 on 7 September.

Use one gate model: definition, instance, and append-only decision. A gate
instance binds the proposed effect to an exact version or digest. Permission,
approval, assignment, and task completion remain distinct. A decision cannot
authorise a changed payload or revive a revoked grant.

Tasks describe human work. Runs and steps describe machine execution. The
execution graph is a read-only explanation of durable records; diagram
metadata does not execute a workflow or grant authority.

Request Changes preserves the task, prior decisions, costs, and valid completed
work within the approved scope and budget. Added cost, access, or scope needs
new approval first. Changed dependencies and effects require renewed review.
Reject stops the proposed work until an authorised restart or redirection.
Mentions and assigned work route requests without granting review authority.

One module owns claiming, applying, and settling an operation. Preserve
version and lease checks while removing duplicate execution-state owners.
Concurrent or retried passes must not repeat an effect or settle another
pass's work. An uncertain external result requires reconciliation before a
retry can be declared safe. Local synthetic-effect proof does not establish
exactly-once execution at an external provider.

Budget reservations and hard ceilings remain in operational Postgres.
Diagnostics cannot approve spending. Consequential actions, access changes,
and actions involving protected information retain their applicable gates,
including in pilots. Break-glass means heightened review, never bypass.

Seeded reviewer-test gates remain a later, disclosed opt-in feature, off by
default and never executable. Standing mandates are later work. Neither is
part of the first task demo. The [first-task draft](../plan/first-task.md)
defines the bounded proposal and required failure cases.
