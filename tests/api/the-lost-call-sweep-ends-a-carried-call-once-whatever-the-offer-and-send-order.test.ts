// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one database and probe, one call per schedule */
//
// The whole lost-call sweep (`sweepModelCalls`: the ten-minute statement for a
// conversation call no carriage has offered, then `sweepCarried`) against a
// carriage that offers a call (`offered_at`) and then sends it (`runner`,
// `request_at`, `send_by`, `answer_by` together), and against a second sweeper.
// Each schedule runs on connections of its own and is ordered by what
// `pg_stat_activity` reports, never by a sleep. A sweeper is stopped inside
// one named statement, after that statement's snapshot, by a probe added to
// this throwaway database: a restrictive policy on the calls table that
// waits on an advisory key only in a transaction that asked for it and only in
// a statement containing the text it named. Outside such a transaction it
// answers true at once.
//
// What must hold in every order: a call ends once; a call whose request was
// sent is never released; a call the sweep has held or released is never
// sent afterwards.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepModelCalls } from '../../packages/core-custody/src/broker.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold as holdKey } from '../support/lock-wait-race.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { carriageBusiness, carriedCall, type CarriageBusiness } from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const PROBE_KEY = 'sweep-order-probe';
/** Text naming the ten-minute statement, and the carried sweep's locking read. */
const TEN_MINUTES = "interval '10 minutes'";
const CARRIED = 'for update of c, k skip locked';

const OFFER = `update model_call_carriers set offered_at = clock_timestamp()
                where business_id = $1 and call_id = $2`;
const SEND = `update model_call_carriers
                 set runner = gen_random_uuid(),
                     request_at = clock_timestamp(), send_by = clock_timestamp() + interval '5 seconds',
                     answer_by = clock_timestamp() + interval '120 seconds'
               where business_id = $1 and call_id = $2`;
const REFUSED = /written unset for a dispatched call, set once/u;

type Swept = { readonly held: number; readonly released: number };

describe.skipIf(serverUrl === undefined)('the lost-call sweep against an offer and a send', () => {
  let db: FreshDatabase;
  let world: CarriageBusiness;
  const pools: Database[] = [];

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'sweep_offer_send_order' });
    await db.admin.execute(`
      create function public.sweep_order_probe() returns boolean
        language plpgsql
        as $$
      begin
        if coalesce(current_setting('order.probe', true), '') <> ''
           and strpos(current_query(), current_setting('order.probe', true)) > 0 then
          perform pg_advisory_xact_lock_shared(hashtextextended('${PROBE_KEY}', 0));
        end if;
        return true;
      end;
      $$`);
    await db.admin.execute('grant execute on function public.sweep_order_probe() to ops_astro_app');
    await db.admin.execute(
      `create policy sweep_order_probe on public.model_calls
         as restrictive for select using (public.sweep_order_probe())`,
    );
  }, 120_000);

  // A business of its own for each schedule, so one schedule's calls are never another's to sweep.
  let made = 0;
  beforeEach(async () => {
    made += 1;
    world = await carriageBusiness(db.app, `sweeporder${String(made)}`);
  });

  afterAll(async () => {
    await Promise.allSettled(pools.map(async (one) => await one.close()));
    await db?.drop();
  });

  const pool = (): Database => {
    const one = connect(db.appUrl, { source: 'runtime' });
    pools.push(one);
    return one;
  };

  /** A carried call on a conversation of its own, started `seconds` ago, never offered. */
  async function callStarted(seconds: number): Promise<string> {
    const { callId } = await db.app.withBusiness(
      world.id,
      async (tx) => await carriedCall(tx, world.owner, world.agent),
    );
    await db.admin.execute(
      `update public.model_calls
          set accepted_at = accepted_at - make_interval(secs => $2),
              started_at = started_at - make_interval(secs => $2)
        where id = $1`,
      [callId, seconds],
    );
    return callId;
  }

  const write = async (sql: string, callId: string): Promise<void> => {
    await pool().withBusiness(world.id, async (tx) => {
      await tx.query(sql, [tx.businessId, callId]);
    });
  };

  const stateOf = async (callId: string) =>
    (
      await db.admin.execute<{
        readonly state: string;
        readonly offered: boolean;
        readonly sent: boolean;
      }>(
        `select c.state, k.offered_at is not null as offered, k.request_at is not null as sent
           from public.model_calls c join public.model_call_carriers k on k.call_id = c.id
          where c.id = $1`,
        [callId],
      )
    )[0];

  /** The whole sweep in a transaction of its own; with `stopIn`, stopped inside that statement. */
  const sweep = async (stopIn?: string): Promise<Swept> =>
    await pool().withBusiness(world.id, async (tx) => {
      if (stopIn !== undefined)
        await tx.query(`select set_config('order.probe', $1, true)`, [stopIn]);
      return await sweepModelCalls(tx);
    });

  /** The probe's key, held until `letGo`, so a sweeper that asked for it stops. */
  const gate = async () =>
    await holdKey(db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [PROBE_KEY]);
    });

  describe('a sweep against a carriage that offers and then sends', () => {
    it('before the offer: a call a minute old is left; the offer and the send follow', async () => {
      const callId = await callStarted(61);
      expect(await sweep()).toEqual({ held: 0, released: 0 });
      await write(OFFER, callId);
      await write(SEND, callId);
      expect(await stateOf(callId)).toEqual({ state: 'dispatched', offered: true, sent: true });
    });

    it('between the offer and the send: released, and the send after it is refused', async () => {
      const callId = await callStarted(61);
      await write(OFFER, callId);
      expect(await sweep()).toEqual({ held: 0, released: 1 });
      await expect(write(SEND, callId)).rejects.toThrow(REFUSED);
      expect(await stateOf(callId)).toEqual({ state: 'released', offered: true, sent: false });
    });

    it('after the send: left dispatched, never released', async () => {
      const callId = await callStarted(61);
      await write(OFFER, callId);
      await write(SEND, callId);
      expect(await sweep()).toEqual({ held: 0, released: 0 });
      expect(await stateOf(callId)).toEqual({ state: 'dispatched', offered: true, sent: true });
    });

    it('a send that waits on the sweep that released the call is refused when the sweep commits', async () => {
      const callId = await callStarted(61);
      await write(OFFER, callId);
      const sweeper = await hold(db.appUrl, world.id, async (tx) => {
        expect(await sweepModelCalls(tx)).toEqual({ held: 0, released: 1 });
      });
      const sending = write(SEND, callId);
      sending.catch(() => null);
      try {
        await waitingOn(db.admin, 'transactionid', 'set runner');
      } finally {
        await sweeper.letGo();
      }
      await expect(sending).rejects.toThrow(REFUSED);
      expect(await stateOf(callId)).toEqual({ state: 'released', offered: true, sent: false });
    });

    it('a send committed after the carried read took its snapshot is read again: not released', async () => {
      const callId = await callStarted(61);
      await write(OFFER, callId);
      const key = await gate();
      let sweeping: Promise<Swept> | undefined;
      try {
        sweeping = sweep(CARRIED);
        await waitingOn(db.admin, 'advisory', CARRIED);
        await write(SEND, callId);
      } finally {
        await key.letGo();
      }
      expect(await sweeping).toEqual({ held: 0, released: 0 });
      expect(await stateOf(callId)).toEqual({ state: 'dispatched', offered: true, sent: true });
    });

    it('an offer and a send both committed after the carried read took its snapshot: not released', async () => {
      const callId = await callStarted(61);
      const key = await gate();
      let sweeping: Promise<Swept> | undefined;
      try {
        sweeping = sweep(CARRIED);
        await waitingOn(db.admin, 'advisory', CARRIED);
        await write(OFFER, callId);
        await write(SEND, callId);
      } finally {
        await key.letGo();
      }
      expect(await sweeping).toEqual({ held: 0, released: 0 });
      expect(await stateOf(callId)).toEqual({ state: 'dispatched', offered: true, sent: true });
    });
  });

  describe('the ten-minute statement against an offer committing during it', () => {
    it('an offer committed after its snapshot: held, and the send after it is refused', async () => {
      const callId = await callStarted(660);
      const key = await gate();
      let sweeping: Promise<Swept> | undefined;
      try {
        sweeping = sweep(TEN_MINUTES);
        await waitingOn(db.admin, 'advisory', TEN_MINUTES);
        await write(OFFER, callId);
      } finally {
        await key.letGo();
      }
      expect(await sweeping).toEqual({ held: 1, released: 0 });
      await expect(write(SEND, callId)).rejects.toThrow(REFUSED);
      expect(await sweep()).toEqual({ held: 0, released: 0 });
      expect(await stateOf(callId)).toEqual({
        state: 'liability_unknown',
        offered: true,
        sent: false,
      });
    });

    it('an offer and a send committed after its snapshot: held as sent, never released', async () => {
      const callId = await callStarted(660);
      const key = await gate();
      let sweeping: Promise<Swept> | undefined;
      try {
        sweeping = sweep(TEN_MINUTES);
        await waitingOn(db.admin, 'advisory', TEN_MINUTES);
        await write(OFFER, callId);
        await write(SEND, callId);
      } finally {
        await key.letGo();
      }
      expect(await sweeping).toEqual({ held: 1, released: 0 });
      expect(await sweep()).toEqual({ held: 0, released: 0 });
      expect(await stateOf(callId)).toEqual({
        state: 'liability_unknown',
        offered: true,
        sent: true,
      });
    });

    it('an offer and a send in one transaction, in flight when it reaches the call: held after the send commits', async () => {
      const callId = await callStarted(660);
      const sender = await hold(db.appUrl, world.id, async (tx) => {
        await tx.query(OFFER, [tx.businessId, callId]);
        await tx.query(SEND, [tx.businessId, callId]);
      });
      let sweeping: Promise<Swept> | undefined;
      try {
        sweeping = sweep();
        await waitingOn(db.admin, 'transactionid', TEN_MINUTES);
      } finally {
        await sender.letGo();
      }
      expect(await sweeping).toEqual({ held: 1, released: 0 });
      expect(await stateOf(callId)).toEqual({
        state: 'liability_unknown',
        offered: true,
        sent: true,
      });
    });
  });

  describe('a crash, a retry, and two sweepers', () => {
    it('an offer committed and then the carriage dies: released a minute after the start', async () => {
      const callId = await callStarted(61);
      await write(OFFER, callId);
      expect(await sweep()).toEqual({ held: 0, released: 1 });
      expect(await stateOf(callId)).toEqual({ state: 'released', offered: true, sent: false });
    });

    it('an offer rolled back: never released as offered; held at ten minutes', async () => {
      const young = await callStarted(61);
      const old = await callStarted(660);
      for (const callId of [young, old]) {
        // oxlint-disable-next-line no-await-in-loop -- one rollback at a time
        const offer = await hold(
          db.appUrl,
          world.id,
          async (tx) => await tx.query(OFFER, [tx.businessId, callId]),
          'rollback',
        );
        // oxlint-disable-next-line no-await-in-loop -- one rollback at a time
        await offer.letGo();
      }
      expect(await sweep()).toEqual({ held: 1, released: 0 });
      expect(await stateOf(young)).toEqual({ state: 'dispatched', offered: false, sent: false });
      expect(await stateOf(old)).toEqual({
        state: 'liability_unknown',
        offered: false,
        sent: false,
      });
    });

    it('a retried offer after one committed is refused', async () => {
      const callId = await callStarted(5);
      await write(OFFER, callId);
      await expect(write(OFFER, callId)).rejects.toThrow(REFUSED);
    });

    it('two sweepers on one never-offered call ten minutes old: held once', async () => {
      const callId = await callStarted(660);
      const key = await gate();
      let first: Promise<Swept> | undefined;
      let second: Swept | undefined;
      try {
        first = sweep(TEN_MINUTES);
        await waitingOn(db.admin, 'advisory', TEN_MINUTES);
        second = await sweep();
      } finally {
        await key.letGo();
      }
      const one = await first;
      expect(second).toEqual({ held: 1, released: 0 });
      expect(one).toEqual({ held: 0, released: 0 });
      expect((await stateOf(callId))?.state).toBe('liability_unknown');
    });

    it('two sweepers on one offered call a minute old: released once', async () => {
      const callId = await callStarted(61);
      await write(OFFER, callId);
      const key = await gate();
      let first: Promise<Swept> | undefined;
      let second: Swept | undefined;
      try {
        first = sweep(CARRIED);
        await waitingOn(db.admin, 'advisory', CARRIED);
        second = await sweep();
      } finally {
        await key.letGo();
      }
      expect(second).toEqual({ held: 0, released: 1 });
      expect(await first).toEqual({ held: 0, released: 0 });
      expect((await stateOf(callId))?.state).toBe('released');
    });

    it('a sweeper whose snapshot predates the offer, against one that sees it and releases: released once, never held after', async () => {
      const callId = await callStarted(660);
      const key = await gate();
      let first: Promise<Swept> | undefined;
      let second: Swept | undefined;
      try {
        first = sweep(TEN_MINUTES);
        await waitingOn(db.admin, 'advisory', TEN_MINUTES);
        await write(OFFER, callId);
        second = await sweep();
      } finally {
        await key.letGo();
      }
      expect(second).toEqual({ held: 0, released: 1 });
      expect(await first).toEqual({ held: 0, released: 0 });
      expect(await stateOf(callId)).toEqual({ state: 'released', offered: true, sent: false });
    });

    it('a sweeper that held the call before the offer, against one that sees the offer: held once, never released, never sent', async () => {
      const callId = await callStarted(660);
      const key = await gate();
      let first: Promise<Swept> | undefined;
      let second: Swept | undefined;
      try {
        // The first has held the call in the ten-minute statement, uncommitted,
        // and stops in the carried read.
        first = sweep(CARRIED);
        await waitingOn(db.admin, 'advisory', CARRIED);
        await write(OFFER, callId);
        second = await sweep();
      } finally {
        await key.letGo();
      }
      expect(second).toEqual({ held: 0, released: 0 });
      expect(await first).toEqual({ held: 1, released: 0 });
      await expect(write(SEND, callId)).rejects.toThrow(REFUSED);
      expect(await stateOf(callId)).toEqual({
        state: 'liability_unknown',
        offered: true,
        sent: false,
      });
    });
  });
});
