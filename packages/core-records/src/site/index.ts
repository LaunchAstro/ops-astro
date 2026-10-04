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
  writeCorrectionDecision,
  type CorrectionState,
  type LiveCorrection,
  type NewLiveCorrection,
  type PartyRefused,
} from './live-corrections.ts';
export {
  holdsAnywhere,
  isActiveMember,
  lockConfiguredApprover,
  readCoveredDecision,
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
