// SPDX-License-Identifier: AGPL-3.0-only
//
// Provider operations: what a model call is, what it may carry and to where
// (AW-01); the catalogue's registration rule, and the live correction's
// catalogued operations and its envelope check (C80).
//
// Nothing here opens a connection or holds a credential. Custody does both
// (`core-custody`), and adapter code never runs in its process.

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
