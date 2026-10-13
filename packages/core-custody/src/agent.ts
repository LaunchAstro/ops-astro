// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's entry into custody (`apps/model-agent/`): the carriage,
// its seals and custody's own process, and nothing of the broker. The agent
// runs on the owner's machine beside Ollama and holds no database: this entry
// reaches no records, runtime or command code and no Postgres driver, which
// `tests/worker/model-agent-boundary.test.ts` walks. It is the one entry
// besides `index.ts` the cruiser lets an app take (`index-only`).

export {
  ACCEPT_WINDOW_MS,
  ANSWER_RESEND_MS,
  ANSWER_RESENDS,
  CALL_KEPT_MS,
  PIECE_EVERY_MS,
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
export { opened, parseCarryKeys, sealed, type CarryKeys, type Sealed } from './carry-seal.ts';
export {
  startCustody,
  type CustodyOutcome,
  type ProcessCustody,
  type SendGate,
} from './custody.ts';
export type { Destination, OutboundRequest } from './egress.ts';
