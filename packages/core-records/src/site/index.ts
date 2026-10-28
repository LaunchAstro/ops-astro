// SPDX-License-Identifier: AGPL-3.0-only
//
// The live correction's records (C80): the request, its decision and the
// receipts of its publish and revert. The command layer reaches them through
// the package index, which re-exports this file whole.

export {
  APPROVER_SETTING,
  GATE_COLLECTION,
  RUN_COLLECTION,
  insertLiveCorrection,
  listCoveredCorrections,
  lockCoveredCorrection,
  type CorrectionState,
  type LiveCorrection,
  type NewLiveCorrection,
  type PageRefused,
  type StoredCorrection,
  type UnpinnedCorrection,
} from './live-corrections.ts';
export {
  holdsAnywhere,
  isActiveMember,
  isVerifiedNow,
  writeCorrectionDecision,
  lockConfiguredApprover,
  readCoveredDecision,
  VERIFIED_FOR_MS,
  type CorrectionDecision,
} from './correction-decisions.ts';
export {
  readCorrectionForRun,
  recordObservedResult,
  type HeldForRun,
  type ObservedResult,
  type ReceiptOutcome,
  type UnderLease,
} from './correction-receipts.ts';
export {
  claimProposal,
  readProposal,
  settleProposal,
  type Claimed,
  type CorrectionProposal,
  type ProposalState,
  type Settlement,
} from './correction-proposals.ts';
export {
  RECEIPT_TEXT_LIMIT,
  listReadableCorrections,
  readReadableReceipts,
  type ReadableCorrection,
  type ReadableReceipt,
  type ReceiptText,
} from './correction-reads.ts';
export { coveredAt, holdCoveringGrants, type Covering } from './covering.ts';
export { insertRevertAsk, type RevertAsk, type RevertAskWrite } from './correction-revert-asks.ts';
export {
  coveredOwnSitePages,
  coversOwnSitePages,
  bindPartySite,
  isBoundPage,
  readPartySite,
  taskClient,
  unbindPartySitePage,
  type PartySiteRecord,
  type SiteWrite,
} from './party-sites.ts';
export {
  SINGLE_OPERATOR_SETTING,
  hasSelfApproved,
  insertReview,
  lockSingleOperatorMode,
  operatorCount,
  reviewApproves,
  type NewReview,
} from './single-operator.ts';
export { correctionOfPlan, planVersionOfDelegation } from './plan-corrections.ts';
