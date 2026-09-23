# First local task specification

Draft for technical review, 8 September 2026. **Amended 10 September 2026**:
the engineer approval this specification relied on was withdrawn and replaced,
per [ADR 0049](../adr/0049-senior-engineer-signed-engagement-stop-authority.md).
This specification applies the
[current decisions](../current-decisions.md) to the first product slice.
Its proposed tickets are not released for implementation. The full build-loop
rehearsal precedes product code. A green conformance proof is required before
protected-component merges; the sandbox's final-contract hold applies before
its implementation.

**This is the 8 September proposal, and the slice that was built differs from
it.** Read [the local slice](../local/README.md) for what exists. Two
differences matter most. The worker of "problem and result" below, which
proposes a change and performs one permitted local effect after approval, was
not built: the runtime proposes, records a decision, leases work and settles
it, and dispatches nothing to any provider. And the ticket withholding above
has been overtaken: local construction proceeded under a later instruction
recorded outside this repository, so the absence of a released ticket here is
not evidence that the slice is unauthorised. Every user story, boundary and
verification row below remains the proposal's, not a record of what passed.

## Problem and result

The foundation has no usable task flow. A person needs to create work, review
a proposed result, request changes, and return later without losing the task
or decision history.

Provide one task workspace using approved existing interactions and real local
Postgres. A deterministic worker proposes a change to a synthetic record.
An authorised person reviews the exact version. Approval permits one local
effect and retains its receipt. A read-only execution view explains persisted
progress, decisions, outcomes, and failures.

## User stories

1. A member can create a task, assign it, set its due date, and change its stage.
2. Reopening after a browser or process restart preserves the task and its review history.
3. A reviewer can inspect the exact input and proposed result version before deciding.
4. An authorised reviewer can approve, request changes, or reject with a recorded decision.
5. Assignment without review authority cannot approve the proposal.
6. Bounded revision retains valid completed work, previous decisions, and costs.
7. Rejection stops progress until an explicit authorised restart or redirection.
8. Another business cannot read or change the task through the UI, API, or database access path.
9. Duplicate or interrupted worker attempts cannot apply the permitted local effect twice.
10. The interface exposes stored evidence and errors, works with a keyboard, and fits a narrow screen.
11. A maintainer can verify the complete journey with one repeatable command and inspect the stored result.

## Proposed implementation boundaries

Tasks remain a built-in record type in the fixed-slot records engine. Introduce
only the business identity, person/actor mapping, grants, and versioned records
needed by this slice. Keep human tasks separate from runs and steps. Derive
intake provenance from the authenticated actor and entry point.

UI and worker commands use one domain interface behind Hono. Derive actor and
business from authenticated context. Permission and approval are separate;
check current authority again when the effect occurs. Changed inputs, scope,
access, or budget cannot reuse an obsolete decision.

One implementation owns claiming, applying, and settling the local operation.
Use persisted receipts to test concurrent attempts and interrupted
acknowledgement. This local proof does not establish exactly-once delivery to
an external provider. Synthetic accounting units can exercise reservations
without spending money.

Transfer task fields, saved-view logic, and useful task-detail interactions
selectively. Freeze the source reference for each element and use the
[shared design contract](../design-system.md). Add the
[typed capability registry and independent discovery checks](../capability-map.md)
with the first product transfer. Existing fixtures and injected tests are
source evidence, not proof of the new persistence path.

The execution view projects stored records. It is not an executable workflow
canvas. Optional trace export can be disabled without preventing durable task
records. Real agents and optional agent frameworks belong to later work.

## Required verification

The primary test drives the visible task and review flow through the public
API into real local Postgres. Pure transition and permission tests add distinct
coverage where needed.

| Case                                         | Required result                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Create, assign, reload, and restart          | Task, proposal, pending decision, and history survive.                                                |
| Wrong business or missing authority          | Refused through UI, API, and applicable database roles without leaking the record.                    |
| Stale approval or revoked authority          | The effect refuses the old decision or grant.                                                         |
| Request changes                              | Valid completed work and prior evidence remain; changed effects receive renewed review.               |
| Reject and retry                             | Work stays stopped until an authorised restart.                                                       |
| Duplicate, concurrent, or interrupted passes | One permitted local effect; a stale pass cannot settle another pass's work.                           |
| Concurrent reservations                      | The approved synthetic limit cannot be exceeded.                                                      |
| Missing data or failures                     | Visible state resolves to durable facts and never fills gaps with fixtures.                           |
| Interaction transfer                         | Approved typography, icons, spacing, states, keyboard controls, and narrow layouts behave coherently. |

Set task load/save and review-response budgets in the executable ticket before
implementation. Measure against the named synthetic dataset and environment.
There is no existing product baseline from which to claim a speed improvement.

## Proposed tickets

| Ticket                              | Complete result                                                                                             | Dependency                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| T1. Persist one human task          | Create, assign, change stage, and reopen through the real data path and first shared UI components.         | Foundation and full-loop rehearsal     |
| T2. Review a local proposal         | Inspect a versioned proposal, record an authorised decision, and apply one synthetic result with a receipt. | T1                                     |
| T3. Amend and recover               | Preserve valid work, reject/restart explicitly, and recover from concurrent or interrupted attempts.        | T2                                     |
| T4. Verify the integrated workspace | Drive the full journey and inspect stored evidence and transferred interactions with a repeatable command.  | T1 to T3 merged under required reviews |

Confirm the seams and breakdown before publishing implementation tickets.
The slice excludes live integrations, arbitrary generated code, a general
workflow canvas, a replacement rich-text editor, full CRM, real personal data,
and a separate analytics installation. It opens no outside contributions.
