// SPDX-License-Identifier: AGPL-3.0-only
//
// The lost-call sweep for a carried call (`sweepCarried`) reads `request_at`
// and releases a call whose request was never sent. Its rows are locked
// `for update of c, k skip locked`, so a sender's `request_at` committed after
// the sweep's statement took its snapshot is read again before anything is
// released. Schedules, each on connections of their own:
//
//   after snapshot  the sweep's statement is stopped mid-scan, after its
//                   snapshot, by a probe added to this throwaway database (a
//                   restrictive policy on the carriers table that waits on an
//                   advisory key only in the sweeping transaction); the sender
//                   commits `request_at` then; the sweep goes on and must not
//                   release the call
//   in flight       the sender's write is uncommitted when the sweep locks: the
//                   row is skipped, not released
//   crash           the sender's write rolls back: request_at null proves
//                   nothing was sent, and the call is released
//   lost answer     request_at committed and answer_by + 60 s passed: held,
//                   never released
//   scope           another business's lost call is not this sweep's
//
// The probe changes no product object's behaviour: outside the sweeping
// transaction it answers true at once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepCarried } from '../../packages/core-custody/src/broker-carriage.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { waitingOn } from '../support/lock-waits.ts';
import { carriageBusiness, carriedCall, type CarriageBusiness } from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const PROBE_KEY = 'race:carried-sweep';

/** The sender's write, in the shape the carriers row takes it: every send time at once. */
const SEND = `update model_call_carriers
                 set offered_at = clock_timestamp() - interval '1 second', runner = gen_random_uuid(),
                     request_at = clock_timestamp(), send_by = clock_timestamp() + interval '5 seconds',
                     answer_by = clock_timestamp() + interval '120 seconds'
               where business_id = $1 and call_id = $2`;

// eslint-disable-next-line max-lines-per-function -- one database, one probe, one call per schedule
describe.skipIf(serverUrl === undefined)('the carried sweep against a sender', () => {
  let db: FreshDatabase;
  let alpha: CarriageBusiness;
  let beta: CarriageBusiness;
  const pools: Database[] = [];

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'carried_sweep_race' });
    alpha = await carriageBusiness(db.app, 'alpha');
    beta = await carriageBusiness(db.app, 'beta');
    await db.admin.execute(`
      create function public.race_sweep_probe() returns boolean
        language plpgsql
        as $$
      begin
        if current_setting('race.probe', true) = 'on' then
          perform pg_advisory_xact_lock_shared(hashtextextended('${PROBE_KEY}', 0));
        end if;
        return true;
      end;
      $$`);
    await db.admin.execute('grant execute on function public.race_sweep_probe() to ops_astro_app');
    await db.admin.execute(
      `create policy race_sweep_probe on public.model_call_carriers
         as restrictive for select using (public.race_sweep_probe())`,
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(pools.map(async (one) => await one.close()));
    await db?.drop();
  });

  const pool = (): Database => {
    const one = connect(db.appUrl, { source: 'runtime' });
    pools.push(one);
    return one;
  };

  /** A carried call on its own conversation, unsent, started `seconds` ago. */
  async function unsent(business: CarriageBusiness, seconds: number): Promise<string> {
    const { callId } = await db.app.withBusiness(
      business.id,
      async (tx) => await carriedCall(tx, business.owner, business.agent),
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

  const stateOf = async (callId: string) =>
    (
      await db.admin.execute<{ readonly state: string; readonly sent: boolean }>(
        `select c.state, k.request_at is not null as sent
           from public.model_calls c join public.model_call_carriers k on k.call_id = c.id
          where c.id = $1`,
        [callId],
      )
    )[0];

  /** The sweep for `business`, in a transaction of its own; with `probe`, stopped mid-scan. */
  const sweep = async (business: CarriageBusiness, probe = false) =>
    await pool().withBusiness(business.id, async (tx) => {
      if (probe) await tx.query(`select set_config('race.probe', 'on', true)`);
      return await sweepCarried(tx);
    });

  it('after snapshot: a request_at committed after the sweep took its snapshot is read again, never released', async () => {
    const callId = await unsent(alpha, 61);
    const gate = await hold(db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [PROBE_KEY]);
    });
    let sweeping: Promise<{ readonly held: number; readonly released: number }> | undefined;
    let control: Promise<readonly { readonly sent: boolean }[]> | undefined;
    try {
      sweeping = sweep(alpha, true);
      // Control: the same read with no lock, stopped at the same place, keeps its snapshot.
      control = pool().withBusiness(alpha.id, async (tx) => {
        await tx.query(`select set_config('race.probe', 'on', true)`);
        return await tx.query<{ readonly sent: boolean }>(
          `select k.request_at is not null as sent /* control */
             from model_calls c join model_call_carriers k
               on k.business_id = c.business_id and k.call_id = c.id
            where c.business_id = $1 and c.id = $2`,
          [tx.businessId, callId],
        );
      });
      // The sweep's statement has its snapshot and is scanning the carriers rows.
      await waitingOn(db.admin, 'advisory', 'for update of c, k skip locked');
      await waitingOn(db.admin, 'advisory', '/* control */');
      await pool().withBusiness(alpha.id, async (tx) => {
        await tx.query(SEND, [tx.businessId, callId]);
      });
      expect((await stateOf(callId))?.sent).toBe(true);
      await gate.letGo();
      // The window was real: a read that took its snapshot there still sees nothing sent.
      expect(await control).toEqual([{ sent: false }]);
      expect(await sweeping).toEqual({ held: 0, released: 0 });
      expect(await stateOf(callId)).toEqual({ state: 'dispatched', sent: true });
    } finally {
      await gate.letGo();
      await sweeping?.catch(() => null);
      await control?.catch(() => null);
    }
  });

  it('in flight: a sender holding its write uncommitted is skipped, not released', async () => {
    const callId = await unsent(alpha, 61);
    const sender = await hold(db, async (execute) => {
      await execute(SEND.replaceAll('model_call_carriers', 'public.model_call_carriers'), [
        alpha.id,
        callId,
      ]);
    });
    try {
      expect(await sweep(alpha)).toEqual({ held: 0, released: 0 });
      await sender.letGo();
      expect(await stateOf(callId)).toEqual({ state: 'dispatched', sent: true });
    } finally {
      await sender.letGo();
    }
  });

  it('crash: a sender that dies before its commit proves nothing was sent, and the call is released', async () => {
    const callId = await unsent(alpha, 61);
    const sender = await hold(
      db,
      async (execute) => {
        await execute(SEND.replaceAll('model_call_carriers', 'public.model_call_carriers'), [
          alpha.id,
          callId,
        ]);
      },
      async () => await Promise.reject(new Error('the sending process died')),
    );
    await expect(sender.letGo()).rejects.toThrow('the sending process died');
    expect(await sweep(alpha)).toEqual({ held: 0, released: 1 });
    expect(await stateOf(callId)).toEqual({ state: 'released', sent: false });
  });

  it('lost answer: a sent call past answer_by + 60 s is held, never released', async () => {
    const callId = await unsent(alpha, 300);
    // Sent, once, with every time set at its writing: the answer was due 61 s ago.
    await db.app.withBusiness(alpha.id, async (tx) => {
      await tx.query(
        `update model_call_carriers
            set offered_at = clock_timestamp() - interval '200 seconds', runner = gen_random_uuid(),
                request_at = clock_timestamp() - interval '199 seconds',
                send_by = clock_timestamp() - interval '195 seconds',
                answer_by = clock_timestamp() - interval '61 seconds'
          where business_id = $1 and call_id = $2`,
        [tx.businessId, callId],
      );
    });
    expect(await sweep(alpha)).toEqual({ held: 1, released: 0 });
    expect(await stateOf(callId)).toEqual({ state: 'liability_unknown', sent: true });
  });

  it("scope: one business's sweep leaves another business's lost call alone", async () => {
    const theirs = await unsent(beta, 61);
    const ours = await unsent(alpha, 61);
    expect(await sweep(alpha)).toEqual({ held: 0, released: 1 });
    expect(await stateOf(ours)).toEqual({ state: 'released', sent: false });
    expect(await stateOf(theirs)).toEqual({ state: 'dispatched', sent: false });
    expect(await sweep(beta)).toEqual({ held: 0, released: 1 });
  });
});
