// SPDX-License-Identifier: AGPL-3.0-only
//
// D06's agent prefix meets `onboarding.step_result` (C41-A) on a step the agent
// holds. Split from `d06-agent.test.ts` so that file stays under the per-file
// cap: this lays out a fresh onboarding, approves its first ready step and
// has the agent pick it up.

import { expect } from 'vitest';
import type { Harness } from './role-case-harness.ts';
import type { Answer } from './world.ts';

/**
 * A fresh client's onboarding, its first ready step, and the reservation a
 * person approved for it. A result closes its step, so each body gets its own.
 */
async function approvedStep(
  harness: Harness,
): Promise<{ readonly taskId: string; readonly reservationId: string }> {
  const made = await harness.asPerson('record.create', {
    type: 'client',
    fields: { name: 'a client the agent works' },
  });
  const clientId = (made.body['detail'] as Record<string, unknown>)['recordId'];
  const started = await harness.asPerson('onboarding.start', {
    clientId,
    templateKey: 'standard',
  });
  const steps = (started.body['detail'] as Record<string, unknown>)['steps'] as readonly {
    readonly taskId: string;
    readonly state: string;
  }[];
  const taskId = String(steps.find((one) => one.state === 'ready')?.taskId);
  const decided = await harness.reserve(
    { id: taskId } as Parameters<Harness['reserve']>[0],
    'onboarding_step',
  );
  expect(decided.code, 'the decision a step pickup needs').toBe('ok');
  const reservationId = String(
    (decided.body['detail'] as Record<string, unknown>)['reservationId'],
  );
  return { taskId, reservationId };
}

/**
 * A result on a fresh onboarding step the agent has just picked up. The held
 * delegation is given back first and the new pickup is tracked, so the matrix
 * releases it like any other.
 */
export async function onStep(
  harness: Harness,
  operationId: string,
  release: () => Promise<void>,
  track: (answer: Answer) => void,
): Promise<{ body: Record<string, unknown>; credential?: string }> {
  await release();
  const { taskId, reservationId } = await approvedStep(harness);
  const pickup = await harness.asAgent('task.pickup', { reservationId });
  track(pickup);
  if (pickup.code !== 'ok') throw new Error('d06-agent: the agent could not pick up the step');
  const credential = String((pickup.body['detail'] as Record<string, unknown>)['credential']);
  const body = { operationId, recordId: taskId, outcome: 'done', result: 'the agent closed it' };
  return { body, credential };
}
