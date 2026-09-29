// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2, what the Agent page tests share: a picked-up run handed back with a
// successor version, whose pending gate is the gate the run reached.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Controls } from './controls-fixture.ts';
import type { PickedUp } from './mp-6-1-checks-fixture.ts';

/** Hands the run back with a successor version, whose pending gate is the run's gate. */
export async function handBack(c: Controls, work: PickedUp): Promise<void> {
  const answer = await c.asAgent(
    'task.handback',
    {
      operationId: randomUUID(),
      leaseId: work.leaseId,
      fence: work.fence,
      outcome: 'completed',
      report: { wrote: 'a draft for review' },
      successor: {
        purpose: `review_${randomUUID().slice(0, 8)}`,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'publish the draft' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
      },
    },
    work.credential,
  );
  expect(answer.status).toBe(200);
}
