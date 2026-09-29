// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's fair share across businesses (ORCH-DECISION SL11 AW-01): a provider
// route has one ceiling for the whole installation, and a business with work
// in flight holds no more than its share of it. The count across businesses
// is read by the broker's own role through one narrow definer function that
// answers one number (no id, no business), and the application reaches it
// only by taking that role. Two businesses of one installation share one
// database here, as they do in production.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import {
  reserveModelCall,
  type Broker,
  type BrokerRoute,
  type ModelCaller,
  type ModelCallField,
  type Reservation,
} from '../../packages/core-custody/src/index.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/index.ts';
import {
  createTask,
  liveWork,
  racer,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  noDatabase,
  useBrokerWorld,
  CLOUD,
  ONE_AT_A_TIME,
  s,
  withRoutes,
  stepOf,
  requestFor,
  callCount,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

const BROKER_ROLE = 'ops_astro_broker';
const ROOM = 'public.model_route_room(text,integer)';

useBrokerWorld('aw01share');

let bravo: Schedules;
let charlie: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  bravo = await seedSchedules(s.db, 'aw01share-bravo', 1_000_000);
  charlie = await seedSchedules(s.db, 'aw01share-charlie', 1_000_000);
}, 180_000);

/** Each case its own route key, so one case's holds never count in another's. */
const route = (key: string, ceiling: number): BrokerRoute => ({ ...CLOUD, key, ceiling });

const callerOf = (owner: Schedules, work: Work): ModelCaller => ({
  actorId: owner.agentActorId,
  delegationId: String(work.picked['delegationId']),
  attendedByPersonId: null,
});

/** Each business's own bound field: a task its person entered (S3). */
const internal = new Map<string, readonly ModelCallField[]>();
async function internalOf(owner: Schedules): Promise<readonly ModelCallField[]> {
  const known = internal.get(owner.business);
  if (known !== undefined) return known;
  const fields = [
    { name: 'tone', from: { recordId: await createTask(owner, 'plain'), key: 'title' } },
  ];
  internal.set(owner.business, fields);
  return fields;
}

async function hold(
  owner: Schedules,
  work: Work,
  with_: Broker,
  operation?: string,
  database: Database = owner.db.app,
): Promise<Reservation> {
  await stepOf(work);
  const fields = await internalOf(owner);
  return await database.withBusiness(
    owner.business,
    async (tx) =>
      await reserveModelCall(
        tx,
        callerOf(owner, work),
        requestFor(work, operation === undefined ? { fields } : { operation, fields }),
        with_,
      ),
  );
}

const outcomeOf = (reservation: Reservation): string =>
  reservation.ok ? 'held' : reservation.code;

const WAIT = { ok: false, code: 'RATE_LIMITED', callId: null, retryAfterSeconds: 5 };

/** The refusal as the caller sees it, without the register's shape. */
function answered(reservation: Reservation): unknown {
  if (reservation.ok) return reservation;
  const { refusal: _refusal, ...result } = reservation;
  return result;
}

/** The function's answer, asked in the business's own transaction as the broker's role. */
async function roomAs(
  owner: Schedules,
  routeKey: string,
  ceiling: number,
  before?: (tx: TenantQuery) => Promise<void>,
): Promise<readonly Record<string, unknown>[]> {
  return await owner.db.app.withBusiness(owner.business, async (tx) => {
    await before?.(tx);
    await tx.query(`select set_config('role', $1, true)`, [BROKER_ROLE]);
    const rows = await tx.query<Record<string, unknown>>(
      'select public.model_route_room($1, $2) as room',
      [routeKey, ceiling],
    );
    await tx.query(`select set_config('role', 'none', true)`);
    return rows;
  });
}

it('AW-01 rate limit: a hold not yet sent counts toward the ceiling', async () => {
  const work = await liveWork(s, 'held not sent', 2_000);
  const one = withRoutes([route('hold-counts', 10)]);
  expect(outcomeOf(await hold(s, work, one, ONE_AT_A_TIME.key))).toBe('held');
  const before = await callCount();
  expect(answered(await hold(s, work, one, ONE_AT_A_TIME.key))).toEqual(WAIT);
  expect(await callCount()).toBe(before);
});

it("AW-01 fair share: a route's ceiling holds across businesses, and the business past it is told to wait with nothing written", async () => {
  const full = withRoutes([route('share-full', 2)]);
  const alpha = await liveWork(s, 'alpha fills the route', 2_000);
  expect(outcomeOf(await hold(s, alpha, full))).toBe('held');
  expect(outcomeOf(await hold(s, alpha, full))).toBe('held');
  const theirs = await liveWork(bravo, 'bravo finds it full', 2_000);
  const before = await callCount();
  expect(answered(await hold(bravo, theirs, full))).toEqual(WAIT);
  expect(await callCount()).toBe(before);
});

it('AW-01 fair share: with another business in flight, a business holds no more than its share', async () => {
  const shared = withRoutes([route('share-split', 4)]);
  const theirs = await liveWork(bravo, 'bravo is in flight', 2_000);
  expect(outcomeOf(await hold(bravo, theirs, shared))).toBe('held');
  const alpha = await liveWork(s, 'alpha takes its share', 2_000);
  // Two businesses in flight: a share of 4 / 2 = 2 each, though the route has room for a third.
  expect(outcomeOf(await hold(s, alpha, shared))).toBe('held');
  expect(outcomeOf(await hold(s, alpha, shared))).toBe('held');
  expect(answered(await hold(s, alpha, shared))).toEqual(WAIT);
  // Bravo's share is untouched by alpha's refusal.
  expect(outcomeOf(await hold(bravo, theirs, shared))).toBe('held');
  expect(answered(await hold(bravo, theirs, shared))).toEqual(WAIT);
});

it('AW-01 fair share: two businesses at once for the last room on the route hold one', async () => {
  const last = withRoutes([route('share-race', 1)]);
  const alpha = await liveWork(s, 'alpha races', 2_000);
  const theirs = await liveWork(bravo, 'bravo races', 2_000);
  await Promise.all([stepOf(alpha), stepOf(theirs)]);
  const racers = [racer(s), racer(bravo)];
  try {
    const both = await Promise.all([
      hold(s, alpha, last, undefined, racers[0]),
      hold(bravo, theirs, last, undefined, racers[1]),
    ]);
    expect(both.map((one) => outcomeOf(one)).toSorted()).toEqual(['RATE_LIMITED', 'held']);
  } finally {
    await Promise.all(racers.map(async (database) => await database?.close()));
  }
  const [flight] = await s.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.model_calls
      where route_key = 'share-race' and state in ('reserved', 'dispatched')`,
  );
  expect(flight?.n).toBe('1');
});

it('AW-01 fair share data separation: one number, the same whichever business holds the calls', async () => {
  const probe = withRoutes([route('share-probe', 2)]);
  const theirs = await liveWork(bravo, 'bravo holds one', 2_000);
  const held = await hold(bravo, theirs, probe);
  expect(outcomeOf(held)).toBe('held');
  const withBravo = await roomAs(s, 'share-probe', 2);
  // One column, one row, a whole number: no id, no business, no count per business.
  expect(withBravo).toEqual([{ room: 1 }]);

  // The same load from another business answers the same: the number cannot say whose it is.
  await s.db.admin.execute(
    `update public.model_calls set state = 'released', ended_at = clock_timestamp()
      where route_key = 'share-probe' and state = 'reserved'`,
  );
  const ours = await liveWork(charlie, 'charlie holds one', 2_000);
  expect(outcomeOf(await hold(charlie, ours, probe))).toBe('held');
  expect(await roomAs(s, 'share-probe', 2)).toEqual(withBravo);

  // At most one: a wide ceiling on an empty route still answers 1, never the room or the load.
  expect(await roomAs(s, 'share-empty', 1_000)).toEqual([{ room: 1 }]);

  // No business in the transaction is no room, never another business's.
  expect(
    await roomAs(s, 'share-empty', 1_000, async (tx) => {
      await tx.query(`select set_config('app.business_id', '', true)`);
    }),
  ).toEqual([{ room: 0 }]);

  // The application's own role is refused before the function runs.
  await expect(
    s.db.app.withBusiness(
      s.business,
      async (tx) => await tx.query('select public.model_route_room($1, $2)', ['share-probe', 2]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('AW-01 fair share: the broker role holds execute on the one function and nothing else', async () => {
  const [role] = await s.db.admin.execute<Record<string, unknown>>(
    `select rolcanlogin, rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = $1`,
    [BROKER_ROLE],
  );
  expect(role).toEqual({
    rolcanlogin: false,
    rolsuper: false,
    rolbypassrls: false,
    rolinherit: true,
  });
  const tables = await s.db.admin.execute<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
        and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and (has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             or (c.relkind = 'S' and has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE')))`,
    [BROKER_ROLE],
  );
  expect(tables).toEqual([]);
  const executes = await s.db.admin.execute<{ schema: string; signature: string }>(
    `select n.nspname as schema, p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
        and has_function_privilege($1, p.oid, 'EXECUTE')`,
    [BROKER_ROLE],
  );
  expect(executes).toEqual([{ schema: 'public', signature: 'model_route_room(text,integer)' }]);
});

it('AW-01 fair share: the application may take the broker role, never inherit it, and the function is pinned', async () => {
  const [membership] = await s.db.admin.execute<Record<string, unknown>>(
    `select m.inherit_option, m.set_option, m.admin_option
       from pg_auth_members m
      where m.roleid = $1::regrole and m.member = 'ops_astro_app'::regrole`,
    [BROKER_ROLE],
  );
  expect(membership).toEqual({ inherit_option: false, set_option: true, admin_option: false });
  const [reach] = await s.db.admin.execute<Record<string, unknown>>(
    `select has_function_privilege('public', $1::regprocedure, 'EXECUTE') as public,
            has_function_privilege('ops_astro_app', $1::regprocedure, 'EXECUTE') as application,
            has_function_privilege($2, $1::regprocedure, 'EXECUTE') as login`,
    [ROOM, s.db.loginRole],
  );
  expect(reach).toEqual({ public: false, application: false, login: false });
  const [shape] = await s.db.admin.execute<Record<string, unknown>>(
    `select p.prosecdef as definer, p.proconfig as config, p.prorettype::regtype::text as returns,
            p.proretset as set, p.provolatile as volatility
       from pg_proc p where p.oid = $1::regprocedure`,
    [ROOM],
  );
  expect(shape).toEqual({
    definer: true,
    config: ['search_path=pg_catalog, public', 'row_security=off'],
    returns: 'integer',
    set: false,
    volatility: 's',
  });
});
