// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent loop on the pinned LangChain stack (#1623 R4). The one package
// that imports `langchain`, `@langchain/*` or `langsmith`
// (`.dependency-cruiser.cjs`). It holds no provider, credential or database:
// every model call is a broker turn and every tool a product call, through
// the ports its caller hands it.

// `runAttempt` is the only way in: the graph is built and invoked inside its
// refusals and its fresh store, never handed out to be invoked another way.
export { runAttempt } from './agent.ts';
export type { AttemptEnd, AttemptPorts, ToolRun } from './agent.ts';
export { entryRefused, isolated, runRefused, TRACING_FLAGS } from './guard.ts';
export { OpsAstroChatModel } from './model.ts';
export type { BrokerPort, Turn, TurnAnswer } from './model.ts';
export { attemptState, RunEnd } from './turn.ts';
export type { AttemptState } from './turn.ts';
