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
// Dispatch marks a step (T2c1, `dispatch.ts`) and observe records the effect the
// worker applied through its owning operation (T2c2, `observe.ts`); no path
// here applies an effect or makes a provider call. `RuntimeRefusalCode` is read
// off the refusal register's rows marked `runtime` (`core-records/src/register.ts`)
// and passed on here with `SUGGESTED_STATUS`, a view of the same rows' statuses
// that the tests read.

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
  setDigest,
  type ActivationMode,
  type ActivationRequest,
  type Activator,
  type AdmittedActivation,
  type CapturedManifest,
  type FileIdentity,
  type InstructionSource,
} from './definitions.ts';
export {
  acceptPlan,
  type PlanAccepted,
  type PlanAcceptRequest,
  type PlanAcceptResult,
} from './plan-accept.ts';
export {
  readPinned,
  type PinnedRead,
  type ReadAuditNote,
  type ReadRequest,
} from './definitions-read.ts';
export {
  heartbeat,
  MAXIMUM_LEASE_LIFETIME_SECONDS,
  MAXIMUM_RENEWAL_SECONDS,
  type HeartbeatRequest,
  type Renewed,
} from './heartbeat.ts';
export { leaseReason, NOT_OWNED_FIX } from './lease-ownership.ts';
export { dispatch, EFFECT_OPERATIONS, type Dispatched, type DispatchRequest } from './dispatch.ts';
export { observe, type AppliedEffect, type Observed, type ObserveRequest } from './observe.ts';
export { readReceipt, receiptTask, type Receipt } from './receipt.ts';
export { readAlerts, type Alert } from './alerts.ts';
export { priceUsage, SYNTHETIC_PRICES, type Usage } from './price-book.ts';
export { openEnvelopeOf, topUp, type Settlement, type TopUp, type TopUpRequest } from './budget.ts';
export { CRASH_POINT_VARIABLE, crashPointAfterCommit, crashSeamProblem } from './crash-point.ts';
export {
  CHECK_OUTCOMES,
  recordCheck,
  type CheckOutcome,
  type CheckRequest,
  type RecordedCheck,
} from './checks.ts';
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
export { reconcileUnknown, type EffectLookup, type Reconciled } from './recovery/reconcile.ts';
export {
  DROP_FAULT,
  recordDrop,
  REPORTED_DROP_CAUSES,
  sweepLostWorkers,
  type DropCause,
} from './recovery/drop.ts';
export {
  joinOutage,
  OUTAGE_WINDOW_SECONDS,
  readOutages,
  type OutageReport,
} from './recovery/outage.ts';
export {
  recordOutcome,
  RECORDED_OUTCOMES,
  type OutcomeRecorded,
  type RecordedOutcome,
} from './recovery/outcome.ts';
export { writeOff, type WriteOffRequest, type WrittenOff } from './recovery/write-off.ts';
export {
  cancelAndClassify,
  classifyUnderLocks,
  replayRecordedTransitions,
  sweepExpiredLeases,
  type Classification,
  type ClassifyRequest,
  type NonclaimableCause,
  classifyAuthorityLoss,
  checkAuthorityAt,
  holdCoveringGrants,
} from './recovery.ts';
export { lockedInstant } from './clock.ts';
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
export {
  endAtBudgetStop,
  topUpAtBudgetStop,
  type EndOutcome,
  type BudgetStopTopUpRequest,
  type TopUpOutcome,
} from './budget-answer.ts';
export type {
  BudgetAnswerCode,
  BudgetAnswerRequest,
  BudgetAnswerResult,
} from './budget-answer-facts.ts';
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
export {
  TRACE_ERRORS,
  TRACE_STAGES,
  TRANSFORM_VERSION,
  TraceRefused,
  derivedId,
  otlp,
  traceSpan,
  type TraceError,
  type TraceSpan,
  type TraceStage,
} from './trace-span.ts';
export {
  TRACE_BATCH,
  exportOnce,
  type Deliver,
  type Delivered,
  type ExportOutcome,
  type GapCode,
  type TraceDatabase,
} from './trace-export.ts';
