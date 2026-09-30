// SPDX-License-Identifier: AGPL-3.0-only
//
// The command package's one way in: the person and agent envelopes, the read
// executor and the refusal shape they answer with. It sits above records and
// the runtime and imports each through its own `index.ts`.
//
// The wire contract (the command surface and the payload digest) is its own
// package, `core-wire`, because the web and the command line need it and must
// not load this entry, which reaches the database.

export { type AgentRequest } from './commands/agent-call.ts';
export { agentAnswer, executeAgentCommand } from './commands/agent-envelope.ts';
export {
  conversationExchange,
  type Asked,
  type ConversationExchange,
  type ConversationReply,
} from './commands/conversation-exchange.ts';
export { describeFault, executeCommand } from './commands/envelope.ts';
export {
  modelCallExecutor,
  type ModelBroker,
  type ModelCallExecutor,
} from './commands/model-call.ts';
// AW-01 J: the worker's occurrence path, never a command (no API route, no CLI).
export {
  startOccurrenceRun,
  type OccurrenceAuthority,
  type OccurrenceRun,
  type ReadOccurrenceAuthority,
} from './commands/occurrence-run.ts';
// C52-A's dispatch hands the worker's occurrence to AW-01 J's write.
export { occurrenceRunStarter } from './commands/automation-run.ts';
export { isCommandRefusal, refuseCommand, type CommandRefusal } from './commands/refusal.ts';
export { type CommandRequest } from './commands/requests.ts';
// T3d1: the pass asks the register whether an unknown step's effect happened.
export { lookupEffect } from './commands/register-store.ts';
export { executeRead } from './reads/execute.ts';
export { joinLiveBoard, shownInbox } from './reads/live-join.ts';
export { isReadName } from './reads/catalogue.ts';
export { type ReadRequest } from './reads/requests.ts';
export {
  purgeConversation,
  writeWrapUp,
  type PurgeOutcome,
  type PurgeRefusalCode,
  type PurgeRequest,
  type WrapUpOutcome,
  type WrapUpRequest,
} from './commands/conversation-lifecycle.ts';
export {
  sweepConversations,
  sweepPurgeOperationId,
  type SweepReport,
  type SweepRequest,
} from './commands/conversation-sweep.ts';
