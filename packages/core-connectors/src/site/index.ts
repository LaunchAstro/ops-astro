// SPDX-License-Identifier: AGPL-3.0-only
//
// The live correction's surface: catalogued operations, envelope check,
// receipts, publish and revert, and the binding and proposal that reach its
// providers (C80). Re-exported whole by the package index.

export { CONNECTOR_HOSTS, SITE_OPERATIONS, siteCatalogue, siteOperation } from './operations.ts';
export { compareCaptures, type PageObservation } from './captures.ts';
export {
  checkEnvelope,
  wordOffsets,
  type CorrectionTarget,
  type EnvelopeResult,
  type ProposedChange,
} from './envelope.ts';
export { approvedChange, contentDigest, versionDigestOf, type VersionPin } from './version.ts';
export { replaced } from './replaced.ts';
export { wordPairRefusal } from './word-pair.ts';
export {
  dispatchToken,
  observeLanded,
  publishCorrection,
  revertCorrection,
  type Accepted,
  type GateDecision,
  type Observed,
  type PublishJob,
  type PublishOutcome,
  type PublishPorts,
  type RevertOutcome,
} from './publish.ts';
export type { Occurrence, ReadBack } from './reconcile.ts';
export {
  bindingRefuses,
  findDeployment,
  mergeAndFind,
  partySiteRefuses,
  readServed,
  readSiteSource,
  revertForward,
  siteBindingFor,
  type BindingDependencies,
  type BoundCorrection,
  type MadeBinding,
  type PartySite,
  type SiteBinding,
} from './binding.ts';
export { readServing } from './serving.ts';
export { proposeSource, type ProposeInput } from './propose.ts';
export {
  ACCEPTANCE_CASES,
  PRECONDITIONS,
  RECEIPT_L_OBSERVATIONS,
  STAYS_HELD,
  receiptL,
  receiptLP,
  type ReceiptLObservations,
} from './receipts.ts';
