// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's model call is marked started under its lease's lock and hands
// custody the lease's end as it stands then (`leaseEnd`). The lease row is
// held on a connection of its own while the start waits on it, and the holder
// shortens the lease before it lets go: custody must be told the shorter end.
// A start whose commit is cut at a named point, its call made again, sends
// once and leaves the cut call's hold to the sweep, never settled.

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { callModel, sweepModelCalls, type Broker } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { hold, latch, waiterOf, type Held } from '../support/lock-wait-race.ts';
import {
  cutProxy,
  liveWork,
  racer,
  settle,
  type CutPoint,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  broker,
  caller,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('leaseendwait');

/** The world's broker, recording each `notAfter` custody is handed. */
function recording(base: Broker = broker) {
  const notAfters: (number | undefined)[] = [];
  const dispatch: Broker['custody']['dispatch'] = async (credentialRef, request) => {
    notAfters.push(request.notAfter);
    return await base.custody.dispatch(credentialRef, request);
  };
  return { broker: { ...base, custody: { ...base.custody, dispatch } }, notAfters };
}

const leaseEndMs = async (work: Work): Promise<number> => {
  const [lease] = await s.db.admin.execute<{ ms: number }>(
    'select (extract(epoch from expires_at) * 1000)::float8 as ms from public.leases where id = $1',
    [work.picked['leaseId']],
  );
  return Number(lease?.ms);
};

it('a start that waited on its lease row while the lease was shortened tells custody the shorter end', async () => {
  const work = await liveWork(s, 'lease shortened in the wait', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const longEnd = await leaseEndMs(work);
  const { broker: base, notAfters } = recording();
  let holding: Promise<Held> | undefined;
  const taken = latch<Held>();
  // Runs between the hold's commit and the start: the lease row is taken here.
  const describing: Broker = {
    ...base,
    custody: {
      ...base.custody,
      describe: async (ref, destination) => {
        holding ??= hold(
          s.db,
          async (execute) => {
            await execute('select id from public.leases where id = $1 for update', [
              work.picked['leaseId'],
            ]);
          },
          async (execute) => {
            await execute(
              `update public.leases set expires_at = clock_timestamp() + interval '30 seconds'
                where id = $1`,
              [work.picked['leaseId']],
            );
          },
        );
        taken.open(await holding);
        return await base.custody.describe(ref, destination);
      },
    },
  };
  const answer = callModel(s.db.app, s.business, caller(work), requestFor(work), describing);
  const held = await taken.promise;
  try {
    await waiterOf(s.db, held);
  } finally {
    await held.letGo();
  }
  expect(await answer).toMatchObject({ ok: true });
  const shortEnd = await leaseEndMs(work);
  expect(shortEnd).toBeLessThan(longEnd - 60_000);
  const [notAfter] = notAfters;
  // `endBy`: five seconds before the lease; a second of leeway for the two hosts' clocks.
  expect(notAfter).toBeLessThanOrEqual(shortEnd - 4_000);
  expect(notAfter).toBeGreaterThanOrEqual(shortEnd - 6_000);
});

/** `base`, its transactions after the first `skip` running over `through`. */
const after = (base: Database, through: Database, skip: number): Database => {
  let seen = 0;
  return {
    ...base,
    withBusiness: async (businessId, run) => {
      seen += 1;
      return await (seen > skip ? through : base).withBusiness(businessId, run);
    },
  };
};

const callStates = async (work: Work): Promise<readonly string[]> =>
  (
    await s.db.admin.execute<{ state: string }>(
      'select state from public.model_calls where lease_id = $1 order by accepted_at',
      [work.picked['leaseId']],
    )
  ).map((row) => row.state);

it.each<CutPoint>(['before-commit', 'after-commit'])(
  'a start whose commit is cut %s, its call made again, sends once and leaves the cut call unsettled',
  async (point) => {
    const work = await liveWork(s, `start cut ${point}`, 2_000);
    await stepOf(work);
    world.provider.mode('answer');
    const sent = world.provider.seen.length;
    const proxy = await cutProxy(s.db.appUrl, point);
    const cut = racer(s, proxy.url);
    try {
      const database = after(s.db.app, cut, 1);
      const [interrupted] = await settle([
        callModel(database, s.business, caller(work), requestFor(work), broker),
      ]);
      expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
      expect(interrupted?.status).toBe('rejected');
    } finally {
      // A client whose socket the relay killed may never finish ending: give it a second.
      await Promise.race([cut.close().catch(() => null), delay(1_000)]);
      await proxy.close();
    }
    expect(world.provider.seen.length - sent).toBe(0);
    expect(await callStates(work)).toEqual([point === 'after-commit' ? 'dispatched' : 'reserved']);
    const again = await callModel(s.db.app, s.business, caller(work), requestFor(work), broker);
    expect(again).toMatchObject({ ok: true });
    expect(world.provider.seen.length - sent).toBe(1);
    // The lease ends; the sweep holds a started call it never heard back from and releases an unsent one.
    await s.db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [work.picked['leaseId']],
    );
    await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
    expect(await callStates(work)).toEqual([
      point === 'after-commit' ? 'liability_unknown' : 'released',
      'settled',
    ]);
  },
);
