// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-29 FIXMONEY (MONEY's left findings 2 and 3): the envelope counts a
// stopped step's spend once, at what it came to.
//
// - A call still open at a cancel keeps the whole hold for a person (AW-01,
//   3a-r2's classifier kept by ORCH62): nothing was counted at its maximum, so
//   when it later settles lower there is nothing to give back, and the sweep
//   leaves the hold for the person.
// - A budget top-up moves the spend to date to the envelope's actual. When the
//   topped-up hold is later classified, only the spend the top-up did not
//   move is counted, not the whole spend again and not nothing.
// Each runs through the real broker, custody, cancel, top-up and pickup.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { sweepLostWorkers } from '../../packages/core-runtime/src/index.ts';
import { appliedDetail, asPerson, liveWork, pickup, rows } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { calls, dispatched, envelopeActual, gated, reservationOf } from './give-back-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('giveback');

it('an open call at a cancel keeps the hold whole, and its lower settle gives nothing back', async () => {
  const work = await liveWork(s, `giveback open ${randomUUID()}`, 2_000);
  world.provider.mode('answer');
  const { broker: slow, open } = gated();
  const pending = call(work, {}, slow);
  await dispatched(work);
  const before = await envelopeActual(work);
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
  expect(await envelopeActual(work), 'nothing counted while the call is open').toBe(before);

  open();
  await pending;

  const [ended] = await calls(work);
  expect(ended?.state).not.toBe('dispatched');
  expect(Number(ended?.came_to)).toBeLessThan(500);
  expect(await envelopeActual(work), 'nothing to give back').toBe(before);
  await s.db.app.withBusiness(s.business, async (tx) => await sweepLostWorkers(tx));
  expect(await envelopeActual(work)).toBe(before);
  const [hold] = await rows<{ state: string }>(
    s,
    'select state from public.reservations where id = $1',
    [reservationOf(work)],
  );
  expect(hold?.state, 'the hold stays for the person').toBe('held');
});

it('a top-up counts only the amount it moved, not the whole spend', async () => {
  // 900 holds one open call at the replay maximum of 500, and the next one stops the run.
  const work = await liveWork(s, `giveback topup ${randomUUID()}`, 900);
  world.provider.mode('answer');
  const { broker: slow, open } = gated();
  const pending = call(work, {}, slow);
  await dispatched(work);
  const before = await envelopeActual(work);
  const stopped = await call(work);
  expect(stopped).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  await openBilling(s);
  const [run] = await rows<{ id: string }>(
    s,
    'select run_id as id from public.reservations where id = $1',
    [reservationOf(work)],
  );
  const answered = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        runId: String(run?.id),
        caller: { kind: 'person', personId: s.decider.personId, actorId: s.decider.actorId },
        subjects: [
          { kind: 'person', id: s.decider.personId },
          { kind: 'actor', id: s.decider.actorId },
        ],
        amountMinor: 1_000,
        currency: 'AUD',
      }),
  );
  expect(answered).toMatchObject({ ok: true, value: { state: 'applied', heldMinor: 1_400 } });
  expect(await envelopeActual(work), 'the top-up moved the open call at 500').toBe(before + 500);
  open();
  await pending;
  const [ended] = await calls(work);
  expect(Number(ended?.came_to)).toBeLessThan(500);

  const again = await pickup(s, reservationOf(work));

  expect(again['reservationId']).not.toBe(reservationOf(work));
  expect(await envelopeActual(work)).toBe(before + Number(ended?.came_to));
});
