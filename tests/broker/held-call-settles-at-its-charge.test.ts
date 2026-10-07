// SPDX-License-Identifier: AGPL-3.0-only
//
// A call whose request has not reached the provider is not closed by a lookup:
// the provider saying it has no record of the call proves nothing while the
// request may still arrive. The call stays held as an unknown liability; its
// late answer settles it at the provider's charge, and the step's hold counts
// that charge once, when a person records the step's outcome. Through the real
// broker, custody, sweep and pass.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { sweepLostWorkers } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { appliedDetail, liveWork, type Work } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { callIn, faultBroker, outcome, pass } from './aw-10-world.ts';
import { noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { calls, dispatched, envelopeActual, gated, reservationOf } from './give-back-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('heldcharge');

beforeAll(async () => {
  if (noDatabase) return;
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
}, 120_000);

/** The work's step hold: what the envelope counts against its cap while it is held. */
const heldOn = async (work: Work): Promise<number> => {
  const [hold] = await s.db.admin.execute<{ held: string }>(
    'select held_minor::text as held from public.reservations where id = $1',
    [reservationOf(work)],
  );
  return Number(hold?.held);
};

/** What the envelope counts for the work's calls: each at what it came to. */
const cameTo = async (work: Work): Promise<number> =>
  (await calls(work)).reduce((sum, one) => sum + Number(one.came_to), 0);

it('a call whose request has not reached the provider is not closed by its lookup; its late answer settles it at its charge, counted once', async () => {
  const work = await liveWork(s, `closes once proved ${randomUUID()}`, 2_000);
  world.provider.mode('answer');
  world.provider.lookupMode('honest');
  const { broker: slow, open } = gated(faultBroker());
  const late = callIn(s, work, slow);
  await dispatched(work);
  const before = await envelopeActual(work);
  const held = await heldOn(work);
  // Its worker is lost: the sweep holds the call unknown while custody still waits on it.
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [work.picked['leaseId']],
  );
  await s.db.app.withBusiness(s.business, async (tx) => await sweepLostWorkers(tx));
  await pass();
  // The request may still reach the provider, so the lookup proves nothing and the call stays held.
  expect(await calls(work)).toMatchObject([{ state: 'liability_unknown', came_to: '0' }]);

  open();

  // The provider processed it and its answer closes the call at the provider's charge.
  // Its lost worker gets no text back; the money is on the call.
  const answered = await late;
  expect(answered).toMatchObject({ ok: false });
  expect(world.provider.processed.has(('callId' in answered ? answered.callId : null) ?? '')).toBe(
    true,
  );
  // The stand-in's answer: 40 units in and 30 out, priced 40 + 2 x 30.
  expect(await cameTo(work)).toBe(100);
  const closedAt = [{ state: 'settled', came_to: '100' }];
  expect(await calls(work)).toMatchObject(closedAt);
  // The step's hold stays whole for a person, counting the charge against the cap; the
  // envelope's actual moves only when the hold ends. A second pass counts nothing again.
  for (let again = 0; again < 2; again += 1) {
    // eslint-disable-next-line no-await-in-loop
    expect(await envelopeActual(work)).toBe(before);
    // eslint-disable-next-line no-await-in-loop
    expect(await heldOn(work)).toBe(held);
    // eslint-disable-next-line no-await-in-loop
    await pass();
  }
  expect(await calls(work)).toMatchObject(closedAt);
  // A person says the step happened: its hold settles whole, the call's charge inside it, once.
  appliedDetail(await outcome(s, work, 'happened'), 'budget.record_outcome');
  expect(await envelopeActual(work)).toBe(before + held);
  await pass();
  expect(await envelopeActual(work), 'counted once').toBe(before + held);
  expect(await calls(work)).toMatchObject(closedAt);
});
