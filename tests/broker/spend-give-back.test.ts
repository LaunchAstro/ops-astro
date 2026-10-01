// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-29 FIXMONEY (MONEY's left findings 2 and 3): the envelope counts a
// stopped step's spend once, at what it came to.
//
// - A call still open when its hold settles is counted at its maximum. When it
//   later settles lower, the envelope gets the difference back, once.
// - A budget top-up moves the spend to date to the envelope's actual. When the
//   topped-up hold is later classified, only the spend the top-up did not
//   move is counted, not the whole spend again and not nothing.
// Each runs through the real broker, custody, cancel, top-up and pickup.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { sweepLostWorkers } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  asPerson,
  liveWork,
  pickup,
  rows,
  type Work,
} from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { broker, call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('giveback');

/** A broker whose custody waits for `open` before it dispatches for real. */
const gated = (): { readonly broker: Broker; readonly open: () => void } => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch: Broker['custody']['dispatch'] = async (credentialRef, request) => {
    await gate;
    return await broker.custody.dispatch(credentialRef, request);
  };
  return {
    broker: { ...broker, custody: { ...broker.custody, dispatch } },
    open: () => release?.(),
  };
};

const reservationOf = (work: Work): string => String(work.decision['reservationId']);

const envelopeActual = async (work: Work): Promise<number> => {
  const [row] = await rows<{ actual: string }>(
    s,
    `select e.actual_minor::text as actual from public.task_envelopes e
       join public.reservations r on r.envelope_id = e.id where r.id = $1`,
    [reservationOf(work)],
  );
  return Number(row?.actual);
};

/** What the call came to once it ended: its actual, or nothing when it was released. */
const calls = async (work: Work) =>
  await rows<{ state: string; reserved: string; came_to: string }>(
    s,
    `select state, reserved_minor::text as reserved,
            (case when state = 'settled' then actual_minor else 0 end)::text as came_to
       from public.model_calls where reservation_id = $1 and state <> 'refused'
      order by accepted_at`,
    [reservationOf(work)],
  );

const dispatched = async (work: Work): Promise<void> => {
  await expect
    .poll(async () => (await calls(work)).map((one) => one.state), { timeout: 5_000 })
    .toContain('dispatched');
};

it('an open call counted at its maximum gives back the difference when it settles lower, once', async () => {
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
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);

  open();
  await pending;

  const [ended] = await calls(work);
  expect(ended?.state).not.toBe('dispatched');
  expect(Number(ended?.came_to)).toBeLessThan(500);
  expect(await envelopeActual(work)).toBe(before + Number(ended?.came_to));
  await s.db.app.withBusiness(s.business, async (tx) => await sweepLostWorkers(tx));
  expect(await envelopeActual(work), 'given back once').toBe(before + Number(ended?.came_to));
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
