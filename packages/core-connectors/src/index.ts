// SPDX-License-Identifier: AGPL-3.0-only
//
// Provider operations: what a model call is, what it may carry and to where
// (AW-01); the catalogue's registration rule, the one guarded provider call,
// the fenced page capture, and the live correction's six operations with the
// executable that performs its one real effect (C80).
//
// Nothing here holds a credential: custody does (`core-custody`), and adapter
// code never runs in its process; a connector borrows through a port the
// caller supplies. Nothing in this package runs unless a worker under a lease
// calls it after the gate.

export {
  catalogue,
  DECLARATIONS,
  registerModelOperation,
  SETTLE_LEVELS,
  type AdapterRequest,
  type Declaration,
  type ModelAnswer,
  type ModelOperation,
  type ModelOperationDeclaration,
  type Registration,
  type SettleLevel,
} from './operation.ts';
export {
  effectiveClass,
  eligibleRoutes,
  LOCAL_MODEL_REQUIRED_WORDS,
  type DataClass,
  type FieldSource,
  type ModelRoute,
  type PromptField,
  type RouteChoice,
  type RouteReach,
} from './data-class.ts';
export {
  readReplayAnswer,
  replayAdapter,
  replayCostMinor,
  REPLAY_COMPOSE,
  REPLAY_MODEL_WINDOW,
  REPLAY_NOTHING_HAPPENED,
  REPLAY_PATH,
  startReplayProvider,
  type ReplayMode,
  type ReplayProvider,
  type SeenRequest,
} from './replay.ts';
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
export { capturePage, type CaptureOptions } from './capture/page.ts';
export {
  PICTURE_POLICY,
  capturePicture,
  type Picture,
  type PictureBrowser,
  type PictureRequest,
  type PictureRoute,
} from './capture/picture.ts';
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
export { approvedChange, contentDigest, versionDigestOf, type VersionPin } from './site/version.ts';
export {
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
