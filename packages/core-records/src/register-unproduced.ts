// SPDX-License-Identifier: AGPL-3.0-only
//
// The registered codes nothing produces yet, split from `register.ts` to keep
// that file under the line limit. It reads the register's code type and adds
// no code.

import type { RefusalCode } from './register.ts';

/**
 * Registered, and nothing in the tree can produce one yet.
 *
 * Why each is unreachable is written beside its row below.
 *
 * Three budget codes are not on the list. `BUDGET_EXHAUSTED` is what the
 * enforcing path returns when an attempt would cross a ceiling a person
 * approved (`core-runtime/src/budget.ts`). `GATE_NOT_APPROVED` and
 * `FOUR_EYES_REQUIRED` belong to the gated money decisions, a top-up and a
 * write-off. The write-off is deferred, so nothing in `apps/` or `packages/`
 * returns `GATE_NOT_APPROVED`: it is registered, unproduced and not on this
 * list, so this list is not every code nothing produces. `FOUR_EYES_REQUIRED`
 * is produced by the top-up (T2e, `core-runtime/src/budget.ts`) and, since
 * T2g, by the gate: the task's assignee is refused a decision on its gate.
 * Asserted by name in `tests/commands/refusal-register.test.ts`, so a part
 * that closes one has to come here and take it off the list.
 * `AUTH_UNKNOWN_LOGIN` was on this list until a review pointed out that the
 * HTTP boundary produces it: a request nothing verified is refused with it
 * before any command runs.
 *
 * **`WRONG_BUSINESS` is on this list by contract, not as a gap.** Minimum
 * contract 4.4 (`research/minimum-contract-2026-09-10/CONTRACT.md:365-371`,
 * corrected 14 September 2026) registers it as unproducible and struck the
 * requirement that the audit record it; 8.2 case 1 (`:491`) repeats the
 * correction. Telling "another business holds this identifier" from "no such
 * identifier" needs a read that is not scoped to the caller's business, and
 * the tenancy law forbids one: row security is forced, the application role
 * owns nothing, and a definer-rights function that answered the question is
 * exactly what case T1-N14 exists to attack. So a cross-business probe is
 * refused `NOT_FOUND` to the caller and audited as `NOT_FOUND` in the prober's
 * own business, and the probed business is not told (the known limit the
 * contract records at `:371`). The code stays registered and unreachable;
 * `tests/tenancy/production-lookup.test.ts` asserts it absent from the audit.
 */
export const UNPRODUCED_CODES: ReadonlySet<RefusalCode> = new Set([
  'WRONG_BUSINESS',
  // Delegation codes no reachable operation raises. `DELEGATION_NARROWED` is
  // not on this list: `grant.revoke` reaches it by revoking the delegating
  // person's grant between a pickup and the agent's next call.
  // `DELEGATION_WIDENS` is reached on the same route, one step earlier: the
  // mint reads the approver's live grants when the agent picks the work up, not
  // when the person approved it, so a grant revoked or expired in between
  // leaves the pickup asking for authority the approver no longer holds
  // (`tests/commands/delegation-widens.test.ts`). These
  // three name a delegation lifecycle (intake, expiry as its own answer, an
  // explicit revocation) that this head's one-task purpose does not
  // distinguish.
  // `DELEGATION_ALREADY_LIVE` is not on this list:
  // `authority/delegations.ts` refuses a second mint under a purpose the agent
  // already holds live, and `task.pickup` reaches it as a 409 rather than the
  // unique index's 503. Nor is `DELEGATION_EXCLUDES_OPERATION`:
  // `agent-envelope.ts` refuses with it any operation outside
  // `AGENT_SURFACE`, and `tests/commands/unproduced-reach.test.ts` reaches it.
  'DELEGATION_EXCLUDES_INTAKE',
  'DELEGATION_EXPIRED',
  'DELEGATION_REVOKED',
  // `GATE_PENDING` left the list with T2g, which raises it on completing a
  // task whose gate is open; `PROPOSAL_SUPERSEDED` and
  // `PROPOSAL_SCOPE_EXCEEDED` left it with T3a, which gave each its producer.
  'TASK_NOT_PICKABLE',
  // The two runtime codes that need something no caller can reach.
  //
  // `EVIDENCE_MISMATCH` needs a gate whose stored digest and version's own
  // disagree, and `propose` writes both from one value, so only an amended row
  // produces it. `LEASE_EXPIRED` needs a handback on a lease that has expired
  // or left `live`, and the agent path meets something else first: `pickup`
  // mints the delegation with the lease's own expiry, so an expired lease
  // arrives as `DELEGATION_NOT_LIVE`; a newer pickup answers
  // `LEASE_NOT_OWNED`; and the handback that settles a lease settles its
  // delegation too.
  //
  // `GATE_EXPIRED` and `CHANGE_ROUNDS_EXHAUSTED` are not on this list: a
  // command case reaches each (`tests/commands/unproduced-reach.test.ts`):
  // `task.propose` takes `expiresInSeconds`, so a one-second window closes
  // before the decision, and `task.propose` on a lineage plus `task.decide`
  // reach the third round. `LEASE_HELD` is reached the same way
  // (`tests/commands/lease-held-reach.test.ts`). A second pickup of the *same*
  // reservation meets `RESERVATION_NOT_CLAIMABLE` first, but pickup keeps a
  // reservation `held`, and a handback releases its hold without closing the
  // task's envelope, so two new lineages approved on one task give two held
  // reservations: the second pickup meets the first one's live lease.
  'EVIDENCE_MISMATCH',
  'LEASE_EXPIRED',
  // Three codes are deliberately **not** on this list, and each is a command
  // path rather than a module one.
  //
  // `LINEAGE_NOT_ON_TASK`: `task.propose` takes `lineageId` from the caller,
  // so naming a live lineage opened on another task of the same business is an
  // ordinary request, and R3 refuses it. `task.cancel` and `task.restart`
  // answer it from `lineageOnTask` (`tasks-controls.ts`) before the runtime.
  //
  // `CAP_BINDING_MISMATCH`: `decide` still raises it, as the second barrier
  // behind the proposal, and no command case reaches it. The cap half of R2 is
  // not command-reachable, since `readBusinessCapId` hands every decision on a
  // business the same cap. Nor is the currency half: `task.propose` checks
  // the currency against the task's
  // cap (its envelope's, else the business cap) before the first write, and
  // refuses another currency `PROPOSAL_SCOPE_EXCEEDED`, so no version in another
  // currency reaches a decision. It stays off this list because the runtime
  // produces it; the list names codes nothing produces.
  //
  // `ACTUAL_EXPENDITURE_UNSUPPORTED`: `task.handback` refuses any non-null
  // `actualMinor`, so a caller reporting a cost — including zero — produces it.
]);
