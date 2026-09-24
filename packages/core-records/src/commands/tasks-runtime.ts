// SPDX-License-Identifier: AGPL-3.0-only
//
// The four operations that were declared, routed, audited and refusing.
//
// `task.propose`, `task.decide`, `task.pickup` and `task.handback` sat in
// `pending.ts` answering `DEPENDENCY_NOT_LANDED` because the gate triple, the
// lease table and the reservation were not in the tree. L4 built them and
// pinned nine exports on `core-runtime/src/index.ts`; this module is the whole
// of what L3 adds, which is the envelope around them.
//
// **What the envelope contributes, and why it is here rather than there.**
//
// 1. *The repeat-request identity.* `propose` and `decide` take no
//    `operationId` — L4 says so in as many words, because the register is this
//    unit's mechanism. A command going through `runCommand` has it already, so
//    a proposal submitted twice under one identity replays the first answer
//    instead of opening a second lineage.
// 2. *The audit trail.* `core-runtime` writes no `audit_events` row, on
//    purpose: the first attempt to write one from `handback.ts` aborted the
//    transaction on a column that does not exist, which is the right answer to
//    a second writer reaching into another unit's trail. So every success and
//    every refusal here is audited by `envelope.ts` around this module,
//    **including the loser of a decision race** (G03): a `GATE_ALREADY_DECIDED`
//    refusal is a refused attempt like any other and leaves the same row.
// 3. *Rolling a refusal back.* A returned runtime refusal must not commit what
//    the handler touched on the way to it. That is `attemptWork`'s savepoint
//    and it costs nothing here: a refusal is a value, so it travels back out
//    through `refused(...)` and the savepoint goes with it. The one thing this
//    module must not do is raise — an exception would take the transaction and
//    the audit row with it.
//
// **What the caller may not name.** The actor, the person, the subjects, the
// signing key, the cap and the authorising person are all the server's. The
// payloads below carry what the proposal *is* and nothing about who is making
// it, which is the same rule `requests.ts` states for `actorId` and
// `businessId`: a field a caller could fill is a field a caller can claim.
//
// The four operations, and lease renewal, live one module each beside this
// one (thermo review b282216, H2). This module re-exports what it exported
// before the split, so the modules that import it are unchanged.

export { MAXIMUM_EXPIRY_SECONDS, EXPIRY_FIX, expiryFrom } from './expiry.ts';
export { proposeOnTask } from './tasks-propose.ts';
export type { ProposeFields } from './tasks-propose.ts';
export { decideOnGate } from './tasks-decide.ts';
export type { DecideFields } from './tasks-decide.ts';
export { pickupReservation, pickupAsPerson } from './tasks-pickup.ts';
export type { PickupFields } from './tasks-pickup.ts';
export { handbackLease, handbackOwnLease } from './tasks-handback.ts';
export type { HandbackFields } from './tasks-handback.ts';
export { readSuccessor } from './successor.ts';
export { readLeaseSeconds, renewLease, heartbeatOwnLease } from './tasks-lease.ts';
export type { RenewalFields } from './tasks-lease.ts';
export { fromRuntime } from './refusal.ts';
