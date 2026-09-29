// SPDX-License-Identifier: AGPL-3.0-only
//
// The runtime surface L3 wires onto the command registry.
//
// Pinned here for the same reason `authority/index.ts` pins L2's: L3 builds
// `task.propose`, `task.decide`, `task.queue`, `task.pickup` and
// `task.handback` against these names, so a later rearrangement inside this
// package is not a change to what L3 imports.
//
// Dispatch marks a step (T2c1, `dispatch.ts`) and observe records the effect the
// worker applied through its owning operation (T2c2, `observe.ts`); no path
// here applies an effect or makes a provider call. And `RuntimeRefusalCode` is exported as this
// package's own type rather than added to `commands/register.ts`: that file is
// L3's, and a module reaching into the command surface to register its own
// codes is the coupling the register exists to prevent. `SUGGESTED_STATUS`
// carries the statuses L3 should give them.

export {
  lockProposal,
  propose,
  proposeUnderLocks,
  roundsUsed,
  type HeldProposal,
  type Proposal,
  type ProposeRequest,
} from './propose.ts';
export { restart, type Restarted, type RestartRequest } from './restart.ts';
export {
  heartbeat,
  MAXIMUM_LEASE_LIFETIME_SECONDS,
  MAXIMUM_RENEWAL_SECONDS,
  type HeartbeatRequest,
  type Renewed,
} from './heartbeat.ts';
export { leaseReason, NOT_OWNED_FIX } from './lease-ownership.ts';
export { dispatch, type Dispatched, type DispatchRequest } from './dispatch.ts';
export { observe, type AppliedEffect, type Observed, type ObserveRequest } from './observe.ts';
export { readReceipt, receiptTask, type Receipt } from './receipt.ts';
export { priceUsage, SYNTHETIC_PRICES, type Usage } from './price-book.ts';
export type { Settlement } from './budget.ts';
export { CRASH_POINT_VARIABLE, crashPointAfterCommit, crashSeamProblem } from './crash-point.ts';
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
  NOT_CLAIMABLE_FIX,
  NOT_CLAIMABLE_REASON,
  type PickedUpByPerson,
} from './pickup.ts';
export {
  handback,
  type HandbackRequest,
  type HandedBack,
  type SuccessorRequest,
  retainHistoricalReport,
  type HandbackHolder,
} from './handback.ts';
export { AffectedSetChanged, requireUnchanged } from './rediscovery.ts';
export { appendRunEvent, type RunEvent, type RunEventKind } from './run-events.ts';
export {
  cancelAndClassify,
  classifyUnderLocks,
  replayRecordedTransitions,
  type Classification,
  type ClassifyRequest,
  type NonclaimableCause,
  classifyAuthorityLoss,
} from './recovery.ts';
export {
  canonicalise,
  chainHash,
  decisionPayload,
  digestOf,
  linkVersionOf,
  sign,
  verify,
  verifyChain,
  CHAIN_GENESIS,
  LINK_VERSION,
  type DecisionPayloadFields,
  type LinkVersion,
  type SigningKey,
  decidedAtText,
  decisionLink,
  keyResolver,
  type KeyResolver,
} from './signing.ts';
export { acquire, LOCK_ORDER, type LockClass, type LockRequest, type LockSet } from './locks.ts';
export {
  isRuntimeRefusal,
  refuse,
  SUGGESTED_STATUS,
  type RuntimeRefusalCode,
  type RuntimeResult,
} from './refusals.ts';
export {
  delegationCredentialKeys,
  gateSigningKey,
  readBusinessCapId,
  runtimeKeys,
  withRuntimeKeys,
  type RuntimeKeys,
} from './runtime-config.ts';
