// SPDX-License-Identifier: AGPL-3.0-only
//
// The runtime surface the command layer (`core-commands`) wires onto the
// command registry.
//
// Pinned here for the same reason `authority/index.ts` pins its own: the
// command layer builds `task.propose`, `task.decide`, `task.queue`,
// `task.pickup` and `task.handback` against these names, so a later
// rearrangement inside this package is not a change to what it imports.
//
// There is deliberately no dispatch, worker or provider export. No path here
// makes a call, and the `planned_steps.dispatched_at` constraint keeps it
// that way. `RuntimeRefusalCode` is read off the refusal register's rows
// marked `runtime` (`core-records/src/register.ts`) and passed on here with
// `SUGGESTED_STATUS`, a view of the same rows' statuses that the tests read.

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
  admitActivation,
  captureManifest,
  identityOf,
  isInstructionPath,
  pinBootstrapFile,
  readPinned,
  setDigest,
  type ActivationMode,
  type ActivationRequest,
  type Activator,
  type AdmittedActivation,
  type CapturedManifest,
  type FileIdentity,
  type InstructionSource,
  type PinnedRead,
  type ReadAuditNote,
  type ReadRequest,
} from './definitions.ts';
export {
  heartbeat,
  MAXIMUM_LEASE_LIFETIME_SECONDS,
  MAXIMUM_RENEWAL_SECONDS,
  type HeartbeatRequest,
  type Renewed,
} from './heartbeat.ts';
export { leaseReason, NOT_OWNED_FIX } from './lease-ownership.ts';
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
