// SPDX-License-Identifier: AGPL-3.0-only
//
// A reconciliation lookup reads its deadline on the host, waits on the
// route's ceiling, takes its slot on the asked call (`lookup_until`), and asks
// custody to end by the deadline. The ceiling's lock is held on a connection
// of its own while the lookup waits on it: custody's end must still fall
// inside the slot the lookup took after the wait. A slot whose commit is cut
// at a named point, its pass run again, asks the provider once.

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import {
  callModelForPlanning,
  reconcileProviderCalls,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { hold, waiterOf } from '../support/lock-wait-race.ts';
import {
  cutProxy,
  racer,
  seedSchedules,
  settle,
  type CutPoint,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { LOCAL, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { faultBroker } from './aw-10-world.ts';
import { ask, local, ownerOf, rowsFor } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('lookupslotrace');

/** A business of its own with one planning reply cut on the wire, held unknown. */
async function heldUnknown(label: string) {
  const on = await seedSchedules(s.db, label, 1_000_000);
  const carried: Broker = { ...faultBroker(), routes: [LOCAL], audit: local(on).audit };
  const request = await ask(on);
  world.provider.mode('cut');
  expect(
    await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, carried),
  ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  world.provider.lookupMode('honest');
  return { on, carried, conversationId: request.conversation.id };
}

const slotOf = async (on: Schedules, conversationId: string): Promise<number | null> => {
  const [row] = await on.db.admin.execute<{ ms: number | null }>(
    `select (extract(epoch from lookup_until) * 1000)::float8 as ms
       from public.model_calls where conversation_id = $1`,
    [conversationId],
  );
  return row?.ms ?? null;
};

it('a lookup that waited on the ceiling is told to end inside the slot it took after the wait', async () => {
  const { on, carried, conversationId } = await heldUnknown('lookupslotwait');
  const seen: { notAfter: number | undefined; slot: number | null }[] = [];
  const recording: Broker = {
    ...carried,
    custody: {
      ...carried.custody,
      dispatch: async (credentialRef, request) => {
        seen.push({ notAfter: request.notAfter, slot: await slotOf(on, conversationId) });
        return await carried.custody.dispatch(credentialRef, request);
      },
    },
  };
  const ceiling = await hold(s.db, async (execute) => {
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `limit:${on.business}:model_call:${REPLAY_COMPOSE.key}`,
    ]);
  });
  const before = world.provider.seen.length;
  try {
    const pass = reconcileProviderCalls(on.db.app, on.business, recording);
    await waiterOf(s.db, ceiling);
    await delay(1_500);
    await ceiling.letGo();
    await pass;
  } finally {
    await ceiling.letGo();
  }
  expect(world.provider.seen.length - before).toBe(1);
  const [asked] = seen;
  if (asked?.notAfter === undefined || asked.slot === null) throw new Error('no slot was taken');
  // A second of leeway for the two hosts' clocks; the wait itself was longer.
  expect(asked.notAfter).toBeLessThanOrEqual(asked.slot - 4_000);
});

/** `base`, its transactions after the first `skip` running over `through`. */
const after = (base: Database, through: Database, skip: number): Database => {
  let count = 0;
  return {
    ...base,
    withBusiness: async (businessId, run) => {
      count += 1;
      return await (count > skip ? through : base).withBusiness(businessId, run);
    },
  };
};

it.each<CutPoint>(['before-commit', 'after-commit'])(
  'a lookup whose slot is cut %s, its pass run again, asks the provider once',
  async (point) => {
    const { on, carried, conversationId } = await heldUnknown(`lookupslotcut${point.slice(0, 1)}`);
    const before = world.provider.seen.length;
    const proxy = await cutProxy(on.db.appUrl, point);
    const cut = racer(on, proxy.url);
    try {
      // The pass's first transaction lists the calls; its second takes the slot.
      const [interrupted] = await settle([
        reconcileProviderCalls(after(on.db.app, cut, 1), on.business, carried),
      ]);
      expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
      expect(interrupted?.status).toBe('rejected');
    } finally {
      // A client whose socket the relay killed may never finish ending: give it a second.
      await Promise.race([cut.close().catch(() => null), delay(1_000)]);
      await proxy.close();
    }
    expect(world.provider.seen.length - before).toBe(0);
    expect((await slotOf(on, conversationId)) === null).toBe(point === 'before-commit');
    if (point === 'after-commit') {
      // The lost worker's slot stands until it ends: the next pass waits its turn and asks nothing.
      const [waited] = await reconcileProviderCalls(on.db.app, on.business, carried);
      expect(waited?.proved).toBe(false);
      expect(world.provider.seen.length - before).toBe(0);
      await on.db.admin.execute(
        `update public.model_calls set lookup_until = clock_timestamp() - interval '1 second'
          where conversation_id = $1`,
        [conversationId],
      );
    }
    await reconcileProviderCalls(on.db.app, on.business, carried);
    expect(world.provider.seen.length - before).toBe(1);
    expect(await rowsFor(on, conversationId)).toHaveLength(1);
  },
);
