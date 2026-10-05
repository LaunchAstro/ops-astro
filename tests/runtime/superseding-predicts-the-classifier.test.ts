// SPDX-License-Identifier: AGPL-3.0-only
//
// The ledger's one rule, pinned to the classifier: for the same hold, what proposal preflight
// predicts superseding gives back (`releasedOnClosing`, #836) is what the classifier gives back
// when a person cancels the lineage, with a settled model call, a call lost mid-flight, a
// dispatch marker and no call at all.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { releasedOnClosing } from '../../packages/core-runtime/src/budget-ledger.ts';
import { appliedDetail, asPerson, liveWork, rows, type Work } from './schedules-harness.ts';
import { t2dHarness } from './t2d-harness.ts';
import { call, gated, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('supersedepin');

const synthetic = t2dHarness(() => s);

const withCall = async (mode: 'answer' | 'cut' | 'none'): Promise<Work> => {
  const work = await liveWork(s, `supersede pin ${mode} ${randomUUID()}`, 500);
  if (mode === 'none') return work;
  world.provider.mode(mode);
  await call(work);
  world.provider.mode('answer');
  return work;
};

/** Synthetic work the agent has dispatched: its attempt carries the dispatch marker. */
const dispatchedWork = async (): Promise<Work> => {
  const work = await synthetic.work();
  await synthetic.dispatched(work);
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
    const work = mode === 'marked' ? await dispatchedWork() : await withCall(mode);
    const prediction = await predicted(work);
    const before = await committedOf(work);

    await cancel(work);

    expect(before - (await committedOf(work))).toBe(prediction);
  });
}

const callStates = async (work: Work): Promise<string> =>
  (
    await rows<{ state: string }>(
      s,
      `select state from public.model_calls where business_id = $1 and reservation_id = $2`,
      [s.business, work.decision['reservationId']],
    )
  )
    .map((one) => one.state)
    .join();

const untilDispatched = async (work: Work): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    if ((await callStates(work)) === 'dispatched') return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
};

// A call with the provider is open but marks nothing (a lost call marks its step as one that may
// have acted), so this case alone holds the open-call half of the rule.
it('preflight predicts what the classifier gives back (in flight, unmarked)', async () => {
  const work = await withCall('none');
  const custody = gated();
  const inFlight = call(work, {}, custody.broker);
  try {
    await untilDispatched(work);
    expect(await callStates(work)).toBe('dispatched');
    const prediction = await predicted(work);
    const before = await committedOf(work);

    await cancel(work);

    expect(prediction).toBe(0n);
    expect(before - (await committedOf(work))).toBe(prediction);
  } finally {
    custody.open();
    await inFlight;
  }
});
