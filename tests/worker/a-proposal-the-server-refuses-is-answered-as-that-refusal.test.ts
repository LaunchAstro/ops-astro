// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8c (#1717): a proposal `task.propose` refuses is answered as that
// refusal, `TRANSITION_NOT_PERMITTED` included. Since R8a a proposal still
// waiting for a person is found again under its own identity and reads
// `queued`, and `task.propose` refuses with that code only a lineage restart,
// which the worker never sends; so nothing turns the refusal into `idle`, and
// the next proposal moves to a new operation as for any other refusal.

import { expect, it } from 'vitest';
import type { Answered, Call, Unanswered } from '../../apps/worker/agent-call.ts';
import { proposeStep, type Proposer } from '../../apps/worker/proposal.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';

const answered = (body: Record<string, unknown>): Answered => ({
  body,
  detail: (body['detail'] as Record<string, unknown> | undefined) ?? {},
});

const REFUSED: Unanswered = { refused: { code: 'TRANSITION_NOT_PERMITTED', names: ['state'] } };

it('answers a TRANSITION_NOT_PERMITTED proposal as its refusal and counts it', async () => {
  const sent: string[] = [];
  const call: Call = async (verb) => {
    sent.push(verb);
    if (verb === 'session.capabilities') {
      return await Promise.resolve(
        answered({ agentActorId: 'agent-1', purposeScope: { id: 'task-1' } }),
      );
    }
    if (verb === 'task.read') return answered({ detail: { task: { revision: 3 } } });
    if (verb === 'task.propose') return REFUSED;
    throw new Error(`unexpected ${verb}`);
  };
  const mine: Proposer = {};

  const outcome = await proposeStep(
    call,
    mine,
    { kind: 'synthetic_comment' },
    SYNTHETIC_USAGE,
    async () => await Promise.resolve({ idle: { taskId: 'task-1' } }),
  );

  expect(outcome).toStrictEqual(REFUSED);
  expect(mine.refusals).toBe(1);
  expect(mine.unanswered).toBeUndefined();
  expect(sent).toStrictEqual(['session.capabilities', 'task.read', 'task.propose']);
});
