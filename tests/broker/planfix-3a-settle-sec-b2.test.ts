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
import { recoverDeployment } from '../../apps/api/recovery-entry.ts';
import { asAgent, asPerson, codeOf, handbackBody, liveWork } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { one } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('pf3asecb2');
// Budget permission for the decider, as a person's outcome needs.
beforeAll(async () => {
  if (!noDatabase) await openBilling(s);
});

const resolve = async (key: string): Promise<string | undefined> =>
  await Promise.resolve(key === 'home' ? s.business : undefined);

// #1623 R1 (B2): only a success hands back now. The call held unknown already
// ended the attempt, so either hand-back is refused at the door and writes no
// outcome on the attempt. Both cases reach the same state, the attempt held
// unknown with no outcome of its own; each keeps its name and the outcome its
// refused hand-back named.
for (const outcome of ['completed', 'failed'] as const) {
  it(`B2: after a ${outcome} hand-back with a call held unknown, a person can record nothing happened`, async () => {
    const work = await liveWork(s, `pf3a sec b2 ${outcome}`, 2_000);
    world.provider.mode('costly');
    expect(await call(work)).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
    const handed = await asAgent(
      s,
      { ...handbackBody(work.picked), outcome },
      String(work.picked['credential']),
    );
    // #1623 R1 (B2): the settlement's stop retired the delegation, so the hand-back is refused.
    expect(codeOf(handed)).toBe('DELEGATION_NOT_LIVE');
    // #1623 R1 (B2): the pass's replay classifies the recorded stop, as the hand-back did.
    expect(await recoverDeployment(s.db.app, resolve, ['home'])).toMatchObject({ ok: true });
    // Setup: the hold is kept for a person, and the attempt carries no outcome of its own.
    expect(
      await one(
        `select r.state as reservation, a.state as attempt, a.outcome
           from public.reservations r
           join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
          where a.id = $1`,
        [work.decision['attemptId']],
      ),
    ).toEqual({ reservation: 'held', attempt: 'liability_unknown', outcome: null });

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
