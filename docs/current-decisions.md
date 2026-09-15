# Current product decisions

Public technical baseline, consolidated 8 September 2026 from Nathan's
confirmed decisions of 6 and 7 September and the 8 September foundation
specification, and amended since for later decisions, which carry their own
dates where they appear. **Amended 10 September 2026**: engineer approval for
the eight protected components was withdrawn and replaced by a green
conformance proof per affected component, per
[ADR 0049](adr/0049-senior-engineer-signed-engagement-stop-authority.md).
This document supersedes earlier public summaries where they differ. It does
not approve implementation, publication, or service activation.

The maintainer's confirmed decisions govern direction. This file carries the
public baseline; ADRs explain its trade-offs and tickets define executable
scope. New decisions must be recorded here before a ticket relies on them.
Private conversation history cannot be an implementation dependency.

## Selected foundation

| Area                   | Decision                                                      | Proof still required                                             |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Application            | TypeScript, React, Vite, and Hono                             | First real product slice                                         |
| Operational store      | Organisation-owned Supabase/Postgres                          | Schema, migrations, access and recovery tests                    |
| Login                  | Supabase Auth behind the product's own permissions contract   | Adapter and exit test to a named alternative                     |
| Records                | Fixed typed slots; tasks are a built-in record type           | Field inventory, slot sizing, backfill and query tests           |
| Knowledge              | Postgres is canonical; exports are projections                | Rich-document body format and safe edit contract                 |
| Diagnostics            | Langfuse selected, optional per installation                  | Pinned profile, licence, access, lifecycle, and trace delivery   |
| Data design            | Separate ClickHouse roles for Langfuse and business analytics | Ownership, mapping, isolation, lifecycle, and deployment profile |
| Development            | Matt Pocock build loop; Pstack standards within it            | Complete hosted rehearsal before product code                    |
| Shared UI and registry | One design system and typed capability contract               | Transfer and independent discovery checks from the first slice   |

The detailed decisions are indexed in [ADRs](adr/README.md). All product
components remain unbuilt in this foundation. Deep Agents, LangGraph,
LangChain, and Langflow are unselected candidates. No new framework is required
to publish the foundation or prove a deterministic local task flow.

## Current domain and behaviour decisions

| ID  | Confirmed requirement                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Mobile remains on the roadmap. A smaller companion and its implementation are deferred.                                                                                                                   |
| C02 | One enduring person identity within each business links changing roles and histories. Removing a login preserves the person's records. Names or email alone must not silently merge confidential records. |
| C03 | Groups and individuals receive explicit resource and action permissions. Clearance and team membership alone are insufficient.                                                                            |
| C04 | Organisation administrators may appoint collection managers with bounded authority over assigned collections.                                                                                             |
| C05 | Break-glass means heightened review for high-consequence actions. It grants no emergency account or permission bypass.                                                                                    |
| C06 | The graph explains tasks, runs, dependencies, proposals, reviews, revisions, and outcomes. It is not an executable canvas or graph database decision.                                                     |
| C07 | Mentions and assigned work route review requests. Routing, assignment, and task completion do not grant authority or constitute a decision.                                                               |
| C08 | Request Changes allows bounded revision within the approved scope and budget. Extra cost, access, or scope waits for new approval. Reject stops work pending an authorised restart or redirection.        |
| C09 | Amendments retain plans, attempts, decisions, costs, and valid completed work. Changed dependencies and effects receive renewed review.                                                                   |
| C10 | Operators have explicit recorded operating and recovery powers. Account ownership remains with the organisation.                                                                                          |
| C11 | Attachment preview, download, and API retrieval check current permission. Copies in prompts, outputs, logs, checkpoints, and traces require their own controls.                                           |
| C12 | Include both ClickHouse roles in the initial data design. Keep business analytics separate from Langfuse's internal schema and credentials.                                                               |
| C13 | Characterise existing behaviour and selectively keep, adapt, redesign, or drop each module. File copying and language conversion do not prove acceptance.                                                 |
| C14 | Transferred capabilities require behavioural tests, debugging, independent model review, Copilot review, and retesting at the actual revision. Protected-component conformance proofs remain.             |
| C15 | Group implementation, necessary corrections, and evidence into useful deliverables. Routine status bookkeeping does not need separate pull requests.                                                      |
| C16 | Target a verified public foundation followed by a coherent local task demo. The exact publication/history procedure remains separate and cannot bypass signing, review, merge strategy, or size rules.    |
| C17 | Consolidate this baseline and supporting evidence before new implementation planning. Reopen decisions for named gaps, changed requirements, or contrary proof.                                           |

## Sequence and holds

The proposed roadmap is foundation, tasks and basic approval, agent work,
Docs, richer review, and CRM. No dates or fixed slice totals are established.
The [first task specification](plan/first-task.md) is the next bounded product
proposal and does not release its draft tickets.

The full build-loop rehearsal precedes product code. A green conformance
proof is required before merging changes to the eight protected components.
The sandbox's final contract must be approved after adversarial findings are
resolved and before implementation. [Contributing](../CONTRIBUTING.md) is the
canonical review and merge procedure.

No external engineer review, legal opinion, security assessment, hosted enforcement,
mailbox delivery, or service deployment is certified here. A public technical
evidence digest with adjudicated verdicts remains outstanding. The
[plan index](plan/README.md) distinguishes that work from the private archive.
