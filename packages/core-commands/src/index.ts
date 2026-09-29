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
export { describeFault, executeCommand } from './commands/envelope.ts';
export {
  runLivePublish,
  runLiveRevert,
  type CorrectionRun,
  type RunnerPorts,
  type RunResult,
} from './commands/live-correction-runner.ts';
export { isCommandRefusal, refuseCommand, type CommandRefusal } from './commands/refusal.ts';
export { type CommandRequest } from './commands/requests.ts';
export { executeRead } from './reads/execute.ts';
export { isReadName } from './reads/catalogue.ts';
export { type ReadRequest } from './reads/requests.ts';
