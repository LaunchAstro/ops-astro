// SPDX-License-Identifier: AGPL-3.0-only
//
// PLANFIX-3A settle, security finding B2: a completed hand-back recorded its
// outcome on the attempt, then the classifier kept the hold for an unknown
// model call and held the attempt unknown. Every person path then writes a
// different outcome, which the attempts trigger refuses (0014), so nobody
// could close the hold. The hand-back leaves such an attempt's outcome to the
// person, as it does for a marked one.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  handbackBody,
  liveWork,
} from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('pf3asecb2');
// Budget permission for the decider, as a person's outcome needs.
beforeAll(async () => {
  if (!noDatabase) await openBilling(s);
});

for (const outcome of ['completed', 'failed'] as const) {
  it(`B2: after a ${outcome} hand-back with a call held unknown, a person can record nothing happened`, async () => {
    const work = await liveWork(s, `pf3a sec b2 ${outcome}`, 2_000);
    world.provider.mode('costly');
    expect(await call(work)).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
    const handed = appliedDetail(
      await asAgent(
        s,
        { ...handbackBody(work.picked), outcome },
        String(work.picked['credential']),
      ),
      'task.handback',
    );
    // Setup: the hold is kept for a person.
    expect(handed['reservationState']).toBe('held');

    const recorded = await asPerson(s, {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: work.taskId,
      attemptId: work.decision['attemptId'],
      outcome: 'nothing_happened',
    });
    expect(codeOf(recorded)).toBe('applied');
  });
}
