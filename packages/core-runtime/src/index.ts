// SPDX-License-Identifier: AGPL-3.0-only
//
// The runtime surface L3 wires onto the command registry.
//
// Pinned here for the same reason `authority/index.ts` pins L2's: L3 builds
// `task.propose`, `task.decide`, `task.queue`, `task.pickup` and
// `task.handback` against these names, so a later rearrangement inside this
// package is not a change to what L3 imports.
//
// Two things are deliberately absent. There is no dispatch, worker or provider
// export — no path here makes a call, and `planned_steps.dispatched_at` is a
// constraint keeping it that way. And `RuntimeRefusalCode` is exported as this
// package's own type rather than added to `commands/register.ts`: that file is
// L3's, and a module reaching into the command surface to register its own
// codes is the coupling the register exists to prevent. `SUGGESTED_STATUS`
// carries the statuses L3 should give them.

export { propose, roundsUsed, type Proposal, type ProposeRequest } from './propose.ts';
export { restart, type Restarted, type RestartRequest } from './restart.ts';
export {
  heartbeat,
  MAXIMUM_LEASE_LIFETIME_SECONDS,
  MAXIMUM_RENEWAL_SECONDS,
  type HeartbeatRequest,
  type Renewed,
} from './heartbeat.ts';
export { renderEvidence, RENDERER, type RenderedPack } from './evidence.ts';
export {
  decide,
  decideAsAgent,
  SYNTHETIC_PRICE_BOOK,
  type Decided,
  type DecideRequest,
  type DecisionKind,
} from './decide.ts';
export {
  pickup,
  queue,
  DECLARED_INCOMPLETENESS,
  type PickedUp,
  type PickupRequest,
  type QueueEntry,
} from './pickup.ts';
export {
  handback,
  type HandbackRequest,
  type HandedBack,
  type SuccessorRequest,
} from './handback.ts';
export {
  cancelAndClassify,
  classifyUnderLocks,
  replayRecordedTransitions,
  type Classification,
  type ClassifyRequest,
  type NonclaimableCause,
} from './recovery.ts';
export {
  canonicalise,
  chainHash,
  digestOf,
  sign,
  verify,
  verifyChain,
  CHAIN_GENESIS,
  type SigningKey,
} from './signing.ts';
export { acquire, LOCK_ORDER, type LockClass, type LockRequest, type LockSet } from './locks.ts';
export {
  isRuntimeRefusal,
  refuse,
  SUGGESTED_STATUS,
  type AnyRefusal,
  type RuntimeRefusal,
  type RuntimeRefusalCode,
  type RuntimeResult,
} from './refusals.ts';
