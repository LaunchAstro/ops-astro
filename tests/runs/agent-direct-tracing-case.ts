// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's case for #1911 (S1911-2), in a fresh process: the owned model built
// directly, with no runner around it, invoked with the environment the
// caller gave it. Prints whether it refused and how many turns it sent.

import { HumanMessage } from '@langchain/core/messages';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { OpsAstroChatModel } from '../../packages/core-agent/src/index.ts';
import { final, scripted } from './agent-ports.ts';

const run = scripted((n) => final(n));
let refused = false;
try {
  await new OpsAstroChatModel(run.ports.broker, run.state).invoke([new HumanMessage('The task.')]);
} catch (error) {
  refused = (error as { endCode?: unknown }).endCode === 'TRACING_NOT_ALLOWED';
}
await awaitAllCallbacks();
await sleep(1500);
process.stdout.write(`${JSON.stringify({ refused, sent: run.sent.length })}\n`);
