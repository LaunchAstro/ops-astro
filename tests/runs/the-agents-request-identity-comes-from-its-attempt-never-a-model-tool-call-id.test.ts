// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8a (#1717): the operation id the agent's correction request carries
// is stored identity, derived from the attempt the worker picked up and the
// request's place in it, never the model's tool-call id or an id the model
// wrote into its arguments. The same attempt asked again names the same
// operation, so the register replays it. The shipped runner, a scripted call
// port; nothing here reaches a network or a database.

import { describe, expect, it } from 'vitest';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import type { Answered, Unanswered } from '../../apps/worker/agent-call.ts';
import type { StepContext } from '../../apps/worker/step-runner.ts';

const TASK = '00000000-0000-4000-8000-0000000000b1';
const ATTEMPT = '00000000-0000-4000-8000-0000000000b2';

const answered = (detail: Record<string, unknown>): Answered => ({ body: { detail }, detail });

/** One compute on `attemptId`, the model asking one correction with its own ids; the bodies sent. */
async function requestsSent(attemptId: string): Promise<Record<string, unknown>[]> {
  const sent: Record<string, unknown>[] = [];
  let turns = 0;
  const context: StepContext = {
    phase: 'compute',
    taskId: TASK,
    attemptId,
    lease: { leaseId: 'lease', fence: 1 },
    call: async (verb, body): Promise<Answered | Unanswered> => {
      if (verb === 'live_correction.request') {
        sent.push(body as Record<string, unknown>);
        return answered({ correctionId: 'c1', state: 'locating' });
      }
      if (verb === 'model.call') {
        turns += 1;
        const toolCalls =
          turns === 1
            ? [
                {
                  id: 'call_model_chosen',
                  name: 'live_correction.request',
                  args: {
                    operationId: 'model-chosen-operation',
                    taskId: TASK,
                    page: 'about',
                    word: 'Townsvile',
                    replacement: 'Townsville',
                  },
                },
              ]
            : [];
        return await Promise.resolve(
          answered({ callId: `answer_${String(turns)}`, text: 'ok', toolCalls }),
        );
      }
      return answered({ task: { revision: 3 } });
    },
  };
  const end = await agentRunner({ operation: 'model.replay_turn' }).compute(context);
  expect(end, JSON.stringify(end)).toMatchObject({ outcome: 'success' });
  return sent;
}

describe("the agent's correction request identity", () => {
  it("is the attempt's own, never the model's tool-call id or an id in its arguments", async () => {
    const [request] = await requestsSent(ATTEMPT);
    expect(request?.['operationId']).toBe(`correction:${ATTEMPT}:1`);
    expect(JSON.stringify(request)).not.toContain('call_model_chosen');
    expect(JSON.stringify(request)).not.toContain('model-chosen-operation');
  });

  it('is the same when the attempt asks again, so the register replays it', async () => {
    const first = await requestsSent(ATTEMPT);
    const again = await requestsSent(ATTEMPT);
    expect(again[0]?.['operationId']).toBe(first[0]?.['operationId']);
  });
});
