// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's entry into custody (`apps/model-agent/`): the carriage,
// its seals, custody's process and the owner's plan sign-in, nothing of the
// broker, so it reaches no database (`tests/worker/model-agent-boundary.test.ts`;
// cruiser `index-only`).

export {
  ACCEPT_WINDOW_MS,
  ANSWER_RESEND_MS,
  ANSWER_RESENDS,
  CALL_KEPT_MS,
  PIECE_EVERY_MS,
  PLAN_ACCEPT_WINDOW_MS,
  PLAN_PREPARE_MS,
  SEAL_LIFE_MS,
  SEND_WINDOW_MS,
  WORKING_EVERY_MS,
  agentTopic,
  callTopic,
  deadlineOf,
  sendable,
  topicOf,
  type CarriedOutcome,
  type Carriage,
  type CarryBodies,
  type CarryEvent,
  type Line,
  type OfferBody,
} from './carriage.ts';
export { realtimeCarriage } from './realtime-carriage.ts';
export { opened, parseCarryKeys, sealed, type CarryKeys, type Sealed } from './carry-seal.ts';
export {
  startCustody,
  type CustodyOutcome,
  type ProcessCustody,
  type SendGate,
} from './custody.ts';
export type { Destination, OutboundRequest } from './egress.ts';
export {
  beginSignIn,
  issuedClientId,
  storeSignIn,
  type SignInAsk,
  type SignInStoreRefusal,
} from './plan-sign-in.ts';
export type { TokenFs } from './token-file.ts';
