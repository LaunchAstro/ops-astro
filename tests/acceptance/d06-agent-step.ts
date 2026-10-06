// SPDX-License-Identifier: AGPL-3.0-only
//
// D06's agent body for an onboarding step's result (C41-A): a result closes
// its step, so each body gets an onboarding of its own, on a client of its
// own, and the agent picks up that onboarding's first ready step. The pickup
// is tracked by the journey's hold, which gives it back before the next one.
// Kept in its own file so `d06-agent.test.ts` stays under its cap.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { AgentHold } from './d06-agent-fixture.ts';
import type { Harness } from './role-case-harness.ts';

const detailOf = (answer: { readonly body: Record<string, unknown> }): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

export async function stepResultBody(
  harness: Harness,
  hold: AgentHold,
  operationId: string,
): Promise<{ body: Record<string, unknown>; credential?: string }> {
  await hold.release();
  const made = await harness.asPerson('record.create', {
    type: 'client',
    fields: { name: `a client the agent works ${randomUUID()}` },
  });
  expect(made.code, 'the client a step needs').toBe('ok');
  const started = await harness.asPerson('onboarding.start', {
    clientId: detailOf(made)['recordId'],
    templateKey: 'standard',
  });
  expect(started.code, 'the onboarding a step needs').toBe('ok');
  const steps = detailOf(started)['steps'] as readonly { taskId: string; state: string }[];
  const taskId = String(steps.find((one) => one.state === 'ready')?.taskId);
  const decided = await harness.reserve(
    { id: taskId, revision: 1 } as Parameters<Harness['reserve']>[0],
    'onboarding_step',
  );
  expect(decided.code, 'the decision a step pickup needs').toBe('ok');
  const reservationId = String(detailOf(decided)['reservationId']);
  const picked = await harness.asAgent('task.pickup', { reservationId });
  expect(picked.code, 'the agent picks the step up').toBe('ok');
  hold.track(picked);
  const credential = String(detailOf(picked)['credential']);
  const body = { operationId, recordId: taskId, outcome: 'done', result: 'the agent closed it' };
  return { body, credential };
}
