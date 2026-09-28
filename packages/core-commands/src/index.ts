// SPDX-License-Identifier: AGPL-3.0-only
//
// The command package's one way in: the person and agent envelopes, the read
// executor and the refusal shape they answer with. It sits above records and
// the runtime and imports each through its own `index.ts`.
//
// `commands/surface.ts` and `commands/digest.ts` are the wire contract. The
// web and the command line import those two files directly, because this
// entry reaches the database and neither client may load it.

export { type AgentRequest } from './commands/agent-call.ts';
export { agentAnswer, executeAgentCommand } from './commands/agent-envelope.ts';
export { canonicalPayload } from './commands/digest.ts';
export { describeFault, executeCommand } from './commands/envelope.ts';
export { isCommandRefusal, refuseCommand, type CommandRefusal } from './commands/refusal.ts';
export { type CommandRequest } from './commands/requests.ts';
export {
  COMMAND_SURFACE,
  DELEGATION_HEADER,
  pathOf,
  PREFIX,
  type CommandDeclaration,
} from './commands/surface.ts';
export { executeRead } from './reads/execute.ts';
export { type ReadRequest } from './reads/requests.ts';
