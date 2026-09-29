// SPDX-License-Identifier: AGPL-3.0-only
//
// Provider operations: the catalogue's registration rule, the one guarded
// provider call, the fenced page capture, and the live correction's six
// operations with the executable that performs its one real effect (C80).
//
// Credentials are borrowed through a port the caller supplies; custody itself
// (C31) is not here. Nothing in this package runs unless a worker under a
// lease calls it after the gate.

export {
  CREDENTIAL_HOSTS,
  DECLARATION_NAMES,
  connectorRelease,
  registerOperation,
  type Acknowledgement,
  type CatalogueRefusalCode,
  type ConnectorDefinition,
  type DeclarationName,
  type OperationDeclaration,
  type OperationRegistration,
  type Registered,
} from './catalogue.ts';
export {
  callConnector,
  type CallDependencies,
  type ConnectorResult,
  type ProviderResult,
  type ProviderValue,
} from './call.ts';
export {
  isDeniedAddress,
  pinnedTransport,
  systemResolver,
  type Resolver,
  type Transport,
  type TransportAnswer,
  type TransportRequest,
} from './capture/transport.ts';
export {
  POOL_REVIEWS_REQUIRED,
  checkPageAllowed,
  fencedFetch,
  type CapturePool,
  type FenceCode,
  type FenceRefusal,
  type Fenced,
  type FetchOptions,
  type Fetched,
} from './capture/fence.ts';
export {
  CONNECTOR_HOSTS,
  SITE_OPERATIONS,
  siteCatalogue,
  siteOperation,
} from './site/operations.ts';
export {
  checkEnvelope,
  compareCaptures,
  wordOffsets,
  type CorrectionTarget,
  type EnvelopeResult,
  type PageObservation,
  type ProposedChange,
} from './site/envelope.ts';
export {
  contentDigest,
  dispatchToken,
  observeLanded,
  publishCorrection,
  revertCorrection,
  type Accepted,
  type GateDecision,
  type PublishJob,
  type PublishOutcome,
  type PublishPorts,
  type RevertOutcome,
} from './site/publish.ts';
export {
  ACCEPTANCE_CASES,
  PRECONDITIONS,
  RECEIPT_L_OBSERVATIONS,
  STAYS_HELD,
  receiptL,
  receiptLP,
  type ReceiptLObservations,
} from './site/receipts.ts';
