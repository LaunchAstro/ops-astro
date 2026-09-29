// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 on the database, continued from aw-01-broker.test.ts: the data-class
// route, the credential rule, the durable ceiling, the last room in a
// reservation, revocation and an expired lease.

import { expect, it as vitestIt } from 'vitest';
import { catalogue, REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  reserveModelCall,
  sendReservedCall,
  type Broker,
  type ModelCallField,
} from '../../packages/core-custody/src/index.ts';
import { openCustodyWorld } from '../custody/custody-world.ts';
import { liveWork, racer } from '../runtime/schedules-harness.ts';
import {
  noDatabase,
  useBrokerWorld,
  PLANTED_PROMPT,
  CLOUD,
  LOCAL,
  ONE_AT_A_TIME,
  s,
  world,
  broker,
  withRoutes,
  stepOf,
  requestFor,
  caller,
  call,
  rowsOf,
  callCount,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw01limits');

it('AW-01 personal information stays local, on the broker: refused before any route, then only the local one', async () => {
  const work = await liveWork(s, 'personal information', 2_000);
  world.provider.mode('answer');
  const before = world.provider.seen.length;
  const personal: readonly ModelCallField[] = [
    {
      name: 'instruction',
      source: 'client_row',
      value: 'Reply to jo@example.test about the enquiry',
    },
  ];
  const refused = await call(work, { fields: personal }, withRoutes([CLOUD]));
  expect(refused).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
    words: expect.stringContaining('waits on a local model'),
  });
  expect(world.provider.seen.length).toBe(before);
  const local = await call(work, { fields: personal }, withRoutes([CLOUD, LOCAL]));
  expect(local.ok).toBe(true);
  expect(await rowsOf((local as { callId: string }).callId)).toMatchObject([
    { route_key: 'on_premises', route_reach: 'local' },
  ]);
  const internal = await call(work, {}, withRoutes([CLOUD, LOCAL]));
  expect(await rowsOf((internal as { callId: string }).callId)).toMatchObject([
    { route_key: 'replay' },
  ]);
});

it('AW-01 subscription refusal, on the broker: an unattended run on a subscription is refused by name', async () => {
  const work = await liveWork(s, 'subscription', 2_000);
  const before = world.provider.seen.length;
  const subscription = { ...CLOUD, credentialKind: 'subscription' as const };
  expect(await call(work, {}, withRoutes([subscription]))).toMatchObject({
    ok: false,
    code: 'SUBSCRIPTION_UNATTENDED',
  });
  expect(
    await call(work, {}, withRoutes([{ ...subscription, installation: 'there' }])),
  ).toMatchObject({
    ok: false,
    code: 'SUBSCRIPTION_OTHER_TENANT',
  });
  expect(world.provider.seen.length).toBe(before);
});

it('AW-01 rate limit: past the durable ceiling the caller is told to wait, and nothing is written', async () => {
  const work = await liveWork(s, 'one at a time', 2_000);
  world.provider.mode('slow');
  const first = call(work, { operation: ONE_AT_A_TIME.key });
  await expect
    .poll(async () =>
      Number(
        (
          await s.db.admin.execute<{ n: string }>(
            `select count(*)::text as n from public.model_calls where operation_key = $1 and state = 'dispatched'`,
            [ONE_AT_A_TIME.key],
          )
        )[0]?.n,
      ),
    )
    .toBe(1);
  const before = await callCount();
  expect(await call(work, { operation: ONE_AT_A_TIME.key })).toEqual({
    ok: false,
    code: 'RATE_LIMITED',
    callId: null,
    retryAfterSeconds: 5,
  });
  expect(await callCount()).toBe(before);
  await first;
});

it('AW-01 last room: two calls at once for room enough for one hold one', async () => {
  // 700 holds one call at the operation's maximum of 500, not two.
  const work = await liveWork(s, 'room for one', 700);
  await stepOf(work);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const racers = [racer(s), racer(s)];
  try {
    const both = await Promise.all(
      racers.map(
        async (database) =>
          await database.withBusiness(
            s.business,
            async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
          ),
      ),
    );
    expect(both.map((one) => (one.ok ? 'held' : one.code)).toSorted()).toEqual([
      'BUDGET_UNAVAILABLE',
      'held',
    ]);
  } finally {
    await Promise.all(racers.map(async (database) => await database.close()));
  }
  const rows = await s.db.admin.execute<{ state: string; reserved_minor: string }>(
    `select state, reserved_minor::text as reserved_minor from public.model_calls
      where lease_id = $1 order by reserved_minor`,
    [work.picked['leaseId']],
  );
  expect(rows).toEqual([
    { state: 'refused', reserved_minor: '0' },
    { state: 'reserved', reserved_minor: '500' },
  ]);
  expect(world.provider.seen.length).toBe(seen);
});

it('AW-01 revocation mid-transfer: that transfer finishes, nothing further is granted', async () => {
  const work = await liveWork(s, 'revoked mid-call', 2_000);
  world.provider.mode('slow');
  const seen = world.provider.seen.length;
  const pending = call(work, {}, withRoutes([CLOUD]));
  await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seen + 1);
  await s.db.admin.execute(
    `update public.delegations set revoked_at = clock_timestamp(), revocation_cause = 'delegation_revoked'
      where id = (select delegation_id from public.leases where id = $1)`,
    [work.picked['leaseId']],
  );
  const inFlight = await pending;
  expect(inFlight).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  expect(await call(work)).toEqual({ ok: false, code: 'AUTHORITY_LOST', callId: null });
});

it('AW-01 revocation between the hold and the send: nothing is sent and the hold is released', async () => {
  const work = await liveWork(s, 'revoked before the send', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  // The hold commits in the caller's transaction, as model.call's does.
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
  );
  if (!reserving.ok) throw new Error(`reserve refused ${reserving.code}`);
  await s.db.admin.execute(
    `update public.delegations set revoked_at = clock_timestamp(), revocation_cause = 'delegation_revoked'
      where id = (select delegation_id from public.leases where id = $1)`,
    [work.picked['leaseId']],
  );
  const sent = await sendReservedCall(
    s.db.app,
    s.business,
    caller(work),
    requestFor(work),
    reserving.reserved,
    broker,
  );
  expect(sent).toEqual({ ok: false, code: 'AUTHORITY_LOST', callId: reserving.reserved.callId });
  expect(world.provider.seen.length).toBe(seen);
  expect(await rowsOf(reserving.reserved.callId)).toMatchObject([
    { state: 'released', started_at: null },
  ]);
});

it('AW-01 expired lease: the cost settles and the work is refused', async () => {
  const work = await liveWork(s, 'expires mid-call', 2_000);
  await stepOf(work);
  world.provider.mode('slow');
  const seen = world.provider.seen.length;
  const pending = callModel(s.db.app, s.business, caller(work), requestFor(work), {
    ...broker,
    operations: catalogue([{ ...REPLAY_COMPOSE, timeoutMs: 20_000 }]),
  });
  await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seen + 1);
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() where id = $1`,
    [work.picked['leaseId']],
  );
  world.provider.mode('answer');
  const result = await pending;
  expect(result).toMatchObject({ ok: false });
});

it('AW-01 recovery: custody lost mid-dispatch holds the maximum as dropped_worker_lost, fault ours, never resent', async () => {
  const lost = await openCustodyWorld();
  try {
    const work = await liveWork(s, 'custody lost', 2_000);
    lost.provider.mode('slow');
    const pending = call(work, {}, { ...broker, custody: lost.custody });
    await expect.poll(() => lost.provider.seen.length, { timeout: 5_000 }).toBe(1);
    lost.custody.kill();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      code: 'LIABILITY_UNKNOWN',
      heldMinor: 500,
      drop: 'dropped_worker_lost',
    });
    expect(await rowsOf((result as { callId: string }).callId)).toMatchObject([
      { state: 'liability_unknown', fault: 'ours', drop_state: 'dropped_worker_lost' },
    ]);
    expect(lost.provider.seen.length).toBe(1);
  } finally {
    await lost.close();
  }
});

it('AW-01 canary: the planted key and the planted prompt reach no row, audit payload or answer', async () => {
  const tables = await s.db.admin.execute<{ dump: string }>(
    `select coalesce(string_agg(t::text, ' '), '') as dump from (
       select row_to_json(m)::text as t from public.model_calls m
       union all select row_to_json(a)::text from public.audit_events a
       union all select row_to_json(c)::text from public.copy_registrations c) rows`,
  );
  const dump = tables[0]?.dump ?? '';
  expect(dump).not.toContain(world.canary);
  expect(dump).not.toContain(PLANTED_PROMPT);
  expect(world.custody.stderr()).not.toContain(world.canary);
  // The provider did receive the prompt: the search above is not vacuous.
  expect(world.provider.seen.some((request) => request.body.includes(PLANTED_PROMPT))).toBe(true);
});

it('AW-01 settlement by the call: a lease that left the caller mid-call settles the cost, and the work is refused', async () => {
  const work = await liveWork(s, 'moves mid-call', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  // The lease leaves the caller while custody has the request: its fence moves on.
  const moving: Broker = {
    ...broker,
    custody: {
      ...world.custody,
      dispatch: async (credentialRef, request) => {
        await s.db.admin.execute(`update public.leases set fence = fence + 1 where id = $1`, [
          work.picked['leaseId'],
        ]);
        return await world.custody.dispatch(credentialRef, request);
      },
    },
  };
  const result = await call(work, {}, moving);
  expect(result).toMatchObject({ ok: false, code: 'LEASE_NOT_OWNED' });
  const callId = result.ok ? null : result.callId;
  expect(callId).not.toBeNull();
  const [row] = await rowsOf(callId);
  expect(row).toMatchObject({ state: 'settled' });
  expect(Number(row?.['actual_minor'])).toBeGreaterThan(0);
  expect(Number(row?.['actual_minor'])).toBeLessThanOrEqual(Number(row?.['reserved_minor']));
});
