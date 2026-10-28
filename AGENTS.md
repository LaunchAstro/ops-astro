# Agent instructions

## Direction

This project is a portable organisational system for records, knowledge,
tasks, and agent work. People retain authority over access, expenditure, and
consequential actions. Durable records must explain progress and decisions.
Build small, verified capabilities that organisations can operate themselves.

## One router

The Matt Pocock loop routes the work. No other routing block applies.

`/grill-with-docs`, `/to-spec`, `/to-tickets`, `/implement`, `/code-review`.
Confirm unresolved seams and the ticket breakdown with the human. Small work
starts at `/implement`. Pstack supplies standards here.

Read [current decisions](docs/current-decisions.md) and the ticket before
work. Read [model roles](docs/agents/model-roles.md) for fresh context,
independent review, and handoffs. Run the
[session check](docs/agents/session-check.md) before implementation. For
built code, start at [the local slice](docs/local/README.md).

## Build and review

One owner, ticket branch, and isolated worktree per ticket. Ticket review
reads the complete committed change. When commits are held during
local foundation preparation, review the actual files and diff against an
identified manifest, as [review checkpoints](docs/agents/review-checkpoint.md)
requires.

The final ticket verifies the integrated feature. Done is a checked artefact.
Another company's model reviews the builder's work; Copilot reviews
the hosted revision.
The merge rule: an agent merges on Nathan's credential once every required
check is green on the head being merged; a change touching one of the eight
protected components merges only on that component's green conformance proof
and Nathan's acceptance; the production deploy is the one other human gate.
[Contributing](CONTRIBUTING.md) holds the seven questions and what stays his.

Run `/security-review` before a pull request touching auth, tenancy, tool
execution, egress, custody, or the audit chain.

Code Factory builds run the
[production variant](https://github.com/LaunchAstro/code-factory/blob/main/docs/variants/production.md)
(Nathan's pick, 28 Oct 2026).

## References

For naming or public copy, read [Product identity](docs/product-identity.md).

[CONTEXT.md](CONTEXT.md) defines terms. [ADRs](docs/adr/README.md) explain
decisions. [Vendored skills](.claude/skills/README.md) define the skill set.
Write Australian English, sentence-case headings, no em dashes. Apply `unslop`.
