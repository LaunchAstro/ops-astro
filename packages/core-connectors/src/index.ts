// SPDX-License-Identifier: AGPL-3.0-only
//
// Provider operations: what a model call is, what it may carry and to where.
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
  CONVERSATION_ANSWER,
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
export { RESEARCH_COMPOSE } from './research.ts';
