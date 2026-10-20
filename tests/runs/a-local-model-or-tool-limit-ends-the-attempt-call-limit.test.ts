// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs for #1911 (S1911-1), assertions unchanged: LangChain's own
// limits, a model call past the limit or more tools asked for than the limit
// in one answer, end the attempt `call_limit / CALL_LIMIT_REACHED`, the
// outcome #1715 names, never a cancellation and never success.

import { expect, it } from 'vitest';
import { runAttempt } from '../../packages/core-agent/src/index.ts';
import { reads, scripted, TASK } from './agent-ports.ts';

it('a local model limit maps to call_limit', async () => {
  const run = scripted((n) => reads(n));
  const end = await runAttempt(run.state, run.ports, 3, 'The task.');
  expect(run.sent).toHaveLength(3);
  expect(end).toEqual({ outcome: 'call_limit', endCode: 'CALL_LIMIT_REACHED' });
});

it('a tool limit before the server model limit maps to call_limit', async () => {
  const run = scripted(() => ({
    callId: 'answer_1',
    text: 'Reading four times.',
    toolCalls: [1, 2, 3, 4].map((n) => ({
      id: `call_${String(n)}`,
      name: 'task.read',
      args: { taskId: TASK },
    })),
  }));
  const end = await runAttempt(run.state, run.ports, 3, 'The task.');
  expect(run.sent).toHaveLength(1);
  expect(end).toEqual({ outcome: 'call_limit', endCode: 'CALL_LIMIT_REACHED' });
});
