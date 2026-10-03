// SPDX-License-Identifier: AGPL-3.0-only
//
// Provider operations: what a model call is, what it may carry and to where
// (AW-01); the catalogue's registration rule, the one guarded provider call
// over the pinned transport, and the live correction's catalogued operations,
// envelope check and publish and revert executable (C80).
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
  EMAIL_NOTHING_HAPPENED,
  EMAIL_PATH,
  EMAIL_SEND,
  EMAIL_SUBJECT,
  emailAdapter,
  emailText,
  readEmailAnswer,
  RESEND_DESTINATION,
} from './email.ts';
export {
  startFakeEmailProvider,
  type FakeEmailMode,
  type FakeEmailProvider,
  type OutboxMessage,
} from './email-fake.ts';
export {
  CONVERSATION_ANSWER,
  readReplayAnswer,
  replayAdapter,
  replayCostMinor,
  REPLAY_COMPOSE,
  REPLAY_MODEL_WINDOW,
  REPLAY_NOTHING_HAPPENED,
  REPLAY_PATH,
  startReplayProvider,
  type ReplayLookupMode,
  type ReplayMode,
  type ReplayProvider,
  type SeenRequest,
} from './replay.ts';
export { readReplayLookup, REPLAY_LOOKUP_PATH, replayLookup } from './replay-lookup.ts';
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
  type ReadBack,
  type RevertOutcome,
} from './site/publish.ts';
