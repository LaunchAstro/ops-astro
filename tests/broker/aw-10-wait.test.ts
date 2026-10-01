// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10, AW-01's fair-share wait and durable ceilings under a real provider
// fault. While another business's call hangs on a provider that stopped
// answering, it holds the route's one place, so this business's call waits:
// refused `RATE_LIMITED` with its retry, and now recorded as a step on the
// waiting run, so the people whose work waits can read that it waits and for
// how long (PI-P-7), and nothing of the other business. Once the hung call
// ends held unknown, the place is free. A provider's own rate limit, declared
// at registration as proof nothing began, releases the hold.

import { expect, it as vitestIt } from 'vitest';
import { liveWork, rows, seedSchedules } from '../runtime/schedules-harness.ts';
import { CLOUD } from './broker-world.ts';
import { callIn, faultBroker, noDatabase, s, useFaultWorld, world } from './aw-10-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('aw10wait');

it('AW-10 fair-share wait under a provider fault: the waiting run reads its RATE_LIMITED wait and retry, names no other business, and goes on once the hung call is held', async () => {
  const bravo = await seedSchedules(s.db, 'aw10wait-bravo', 1_000_000);
  const one = { ...faultBroker(), routes: [{ ...CLOUD, key: 'aw10-wait', ceiling: 1 }] };
  const theirs = await liveWork(bravo, 'aw10 hung', 2_000);
  world.provider.mode('slow');
  const seen = world.provider.seen.length;
  const hung = callIn(bravo, theirs, one);
  await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seen + 1);

  const mine = await liveWork(s, 'aw10 waits', 2_000);
  const waited = await callIn(s, mine, one);
  expect(waited).toMatchObject({
    ok: false,
    code: 'RATE_LIMITED',
    retryAfterSeconds: 5,
    callId: expect.any(String),
  });
  const recorded = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query<Record<string, unknown>>(
        `select * from public.model_calls where business_id = $1 and lease_id = $2`,
        [tx.businessId, mine.picked['leaseId']],
      ),
  );
  expect(recorded).toMatchObject([{ state: 'refused', refusal_code: 'RATE_LIMITED' }]);
  expect(JSON.stringify(recorded)).not.toContain(bravo.business);
  // The other business reads nothing of the wait.
  const across = await bravo.db.app.withBusiness(
    bravo.business,
    async (tx) =>
      await tx.query(`select 1 from public.model_calls where lease_id = $1`, [
        mine.picked['leaseId'],
      ]),
  );
  expect(across).toHaveLength(0);

  // The hung call times out and is held unknown, a fault nobody can place; the place frees.
  expect(await hung).toMatchObject({ code: 'LIABILITY_UNKNOWN', fault: 'undetermined' });
  world.provider.mode('answer');
  expect(await callIn(s, mine, one)).toMatchObject({ ok: true });
});

it("AW-10 fair-share wait: a provider's own rate limit, declared as proof nothing began, releases the whole hold", async () => {
  const work = await liveWork(s, 'aw10 limited', 2_000);
  world.provider.mode('rate_limited');
  const result = await callIn(s, work);
  expect(result).toMatchObject({ ok: false, code: 'CALL_RELEASED', reason: 'http_429' });
  expect(
    await rows(s, `select state from public.model_calls where lease_id = $1`, [
      work.picked['leaseId'],
    ]),
  ).toMatchObject([{ state: 'released' }]);
});
