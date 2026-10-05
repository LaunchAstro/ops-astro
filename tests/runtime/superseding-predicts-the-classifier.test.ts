// SPDX-License-Identifier: AGPL-3.0-only
//
// The ledger's one rule, pinned to the classifier: for the same hold, what proposal preflight
// predicts superseding gives back (`releasedOnClosing`, #836) is what the classifier gives back
// when a person cancels the lineage, with a settled model call, a call lost mid-flight, a
// dispatch marker and no call at all.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { releasedOnClosing } from '../../packages/core-runtime/src/budget-ledger.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  liveWork,
  rows,
  type Work,
} from './schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('supersedepin');

const withCall = async (mode: 'answer' | 'cut' | 'none'): Promise<Work> => {
  const work = await liveWork(s, `supersede pin ${mode} ${randomUUID()}`, 500);
  if (mode === 'none') return work;
  world.provider.mode(mode);
  await call(work);
  world.provider.mode('answer');
  return work;
};

const predicted = async (work: Work): Promise<bigint> =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      (await releasedOnClosing(tx, [String(work.decision['versionId'])], null)).released,
  );

const cancel = async (work: Work): Promise<void> => {
  appliedDetail(
    await asPerson(s, {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: work.taskId,
      lineageId: work.proposal['lineageId'],
      reason: 'the client withdrew the request',
    }),
    'task.cancel',
  );
};

const committedOf = async (work: Work): Promise<bigint> => {
  const [row] = await rows<{ committed: string }>(
    s,
    `select (e.held_minor + e.actual_minor)::text as committed
       from public.reservations r
       join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
      where r.business_id = $1 and r.id = $2`,
    [s.business, work.decision['reservationId']],
  );
  return BigInt(row?.committed ?? '0');
};

for (const mode of ['answer', 'cut', 'none', 'marked'] as const) {
  it(`preflight predicts what the classifier gives back (${mode})`, async () => {
    const work = await withCall(mode === 'marked' ? 'none' : mode);
    if (mode === 'marked') {
      appliedDetail(
        await asAgent(s, {
          command: 'task.dispatch',
          operationId: randomUUID(),
          leaseId: work.picked['leaseId'],
          fence: work.picked['fence'],
        }),
        'task.dispatch',
      );
    }
    const prediction = await predicted(work);
    const before = await committedOf(work);

    await cancel(work);

    expect(before - (await committedOf(work))).toBe(prediction);
  });
}
