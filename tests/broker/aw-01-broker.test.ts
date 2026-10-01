// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 on the database: a priced model call made through the broker, with
// custody's real process and the replay provider on loopback, against work
// that was really proposed, approved and picked up through the command entry.
//
// The invariant `reservation_before_dispatch_through_broker` is first: the
// call's hold is a committed row at the operation's maximum before custody is
// asked, and a call the reservation cannot cover is refused and recorded with
// nothing sent.
//
// The shared world (a schedules database, custody's process and the replay
// provider) is broker-world.ts. The cases are in three files, each on its own
// database and custody, and each ends with the canary over its own rows:
// money and the six facts here, routes, limits and revocation in
// aw-01-broker-limits.test.ts, recovery, the copy register and isolation in
// aw-01-broker-isolation.test.ts.

import { expect, it as vitestIt } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { callModel } from '../../packages/core-custody/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import {
  noDatabase,
  useBrokerWorld,
  PLANTED_PROMPT,
  CLOUD,
  NOT_RECONCILABLE,
  s,
  world,
  broker,
  withRoutes,
  stepOf,
  requestFor,
  caller,
  call,
  rowsOf,
  rowsOnLease,
  callCount,
  digestOf,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw01broker');

it('reservation_before_dispatch_through_broker', async () => {
  const work = await liveWork(s, 'the invariant', 2_000);
  world.provider.mode('slow');
  const seenBefore = world.provider.seen.length;
  const pending = call(work, {}, withRoutes([CLOUD]));
  await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seenBefore + 1);
  // The provider has the request, and the hold was committed before it did.
  const held = await s.db.admin.execute<{
    state: string;
    reserved_minor: string;
    started: boolean;
  }>(
    `select state, reserved_minor::text as reserved_minor, started_at >= accepted_at as started
       from public.model_calls where lease_id = $1`,
    [work.picked['leaseId']],
  );
  expect(held).toEqual([{ state: 'dispatched', reserved_minor: '500', started: true }]);
  await pending;

  // A call the reservation cannot cover is refused, recorded, and never sent.
  const small = await liveWork(s, 'too small to cover', 300);
  const before = world.provider.seen.length;
  const refused = await call(small);
  expect(refused).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  expect(world.provider.seen.length).toBe(before);
  const recorded = await rowsOf(refused.ok ? null : (refused as { callId: string }).callId);
  expect(recorded).toMatchObject([
    { state: 'refused', refusal_code: 'BUDGET_UNAVAILABLE', reserved_minor: '0' },
  ]);
});

it('AW-01 settlement releases the difference: held at the maximum, settled at the price, the rest released', async () => {
  const work = await liveWork(s, `one priced call ${PLANTED_PROMPT}`, 2_000);
  world.provider.mode('answer');
  const result = await call(work);
  expect(result).toEqual({
    ok: true,
    callId: expect.any(String),
    text: 'Drafted.',
    reservedMinor: 500,
    actualMinor: 100,
    releasedMinor: 400,
  });
  const [row] = await rowsOf(result.ok ? result.callId : null);
  expect(row).toMatchObject({
    state: 'settled',
    reserved_minor: '500',
    actual_minor: '100',
    route_key: 'replay',
    route_reach: 'cloud',
    credential_kind: 'api_key',
    account: 'replay-account-1',
  });
  // Accepted, started, completed: three facts; the operation declares no landing.
  expect(row?.['accepted_at']).toBeInstanceOf(Date);
  expect(row?.['started_at']).toBeInstanceOf(Date);
  expect(row?.['completed_at']).toBeInstanceOf(Date);
  expect(row?.['landed_at']).toBeNull();
  const detail = {
    callId: result.ok ? result.callId : '',
    operation: REPLAY_COMPOSE.key,
    route: 'replay',
    credentialKind: 'api_key',
    reservedMinor: 500,
    actualMinor: 100,
    releasedMinor: 400,
  };
  const events = await s.db.admin.execute<{ command: string; outcome: string }>(
    `select command, outcome from public.audit_events where payload_digest = $1`,
    [digestOf(detail)],
  );
  expect(events).toEqual([{ command: 'model.call_dispatched', outcome: 'applied' }]);
});

it('AW-01 cost above reservation: refused, the amount recorded and audited, held at the maximum', async () => {
  // 1 000 held for the run: the held 500 leaves room for one more call, not two.
  const work = await liveWork(s, 'a costly answer', 1_000);
  world.provider.mode('costly');
  const result = await call(work);
  expect(result).toMatchObject({
    ok: false,
    code: 'LIABILITY_UNKNOWN',
    heldMinor: 500,
    observedMinor: 1000,
  });
  const callId = (result as { callId: string }).callId;
  expect(await rowsOf(callId)).toMatchObject([
    { state: 'liability_unknown', observed_minor: '1000', ended_at: null },
  ]);
  const refusal = await s.db.admin.execute<{ attempted: Record<string, unknown> }>(
    `select attempted from public.audit_events where command = 'model.call_held' and attempted->>'callId' = $1`,
    [callId],
  );
  expect(refusal).toMatchObject([{ attempted: { heldMinor: 500, observedMinor: 1000 } }]);
  // The held maximum stays held: the next call finds less room.
  world.provider.mode('answer');
  const next = await call(work);
  expect(next).toMatchObject({ ok: true, actualMinor: 100 });
  const third = await call(work);
  expect(third).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
});

it('AW-01 positive proof that nothing happened releases the whole hold', async () => {
  const work = await liveWork(s, 'nothing happened', 2_000);
  world.provider.mode('nothing_happened');
  const result = await call(work);
  expect(result).toMatchObject({
    ok: false,
    code: 'CALL_RELEASED',
    reason: 'rejected_before_processing',
  });
  expect(await rowsOf((result as { callId: string }).callId)).toMatchObject([
    { state: 'released' },
  ]);
});

it('AW-01 hostile provider: each answer is refused or bounded and moves no money beyond the hold', async () => {
  for (const mode of ['oversized', 'redirect', 'malformed', 'slow'] as const) {
    // eslint-disable-next-line no-await-in-loop
    const work = await liveWork(s, `hostile ${mode}`, 2_000);
    world.provider.mode(mode);
    // eslint-disable-next-line no-await-in-loop
    const result = await call(work);
    expect(result, mode).toMatchObject({
      ok: false,
      code: 'LIABILITY_UNKNOWN',
      heldMinor: 500,
      drop: 'dropped_no_answer',
    });
    // eslint-disable-next-line no-await-in-loop
    const [row] = await rowsOf((result as { callId: string }).callId);
    expect(row, mode).toMatchObject({
      state: 'liability_unknown',
      reserved_minor: '500',
      actual_minor: null,
    });
  }
  const planted = await liveWork(s, 'hostile planted', 2_000);
  world.provider.mode('planted');
  const before = world.provider.seen.length;
  const result = await call(planted);
  expect(result).toMatchObject({ ok: true, actualMinor: 100 });
  expect(world.provider.seen.length).toBe(before + 1);
});

it('AW-01 six facts: none is taken from the caller', async () => {
  const work = await liveWork(s, 'six facts', 2_000);
  world.provider.mode('answer');
  const before = await callCount();
  const other = await liveWork(s, 'another run', 2_000);
  for (const overrides of [
    { fence: Number(work.picked['fence']) + 1 },
    { leaseId: randomUUID() },
    { stepId: await stepOf(other) },
    { stepId: randomUUID() },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    expect(await call(work, overrides)).toEqual({
      ok: false,
      code: 'LEASE_NOT_OWNED',
      callId: null,
    });
  }
  await stepOf(work);
  const stranger = await callModel(
    s.db.app,
    s.business,
    { ...caller(work), actorId: randomUUID() },
    requestFor(work),
    broker,
  );
  expect(stranger).toEqual({ ok: false, code: 'LEASE_NOT_OWNED', callId: null });
  expect(await callCount()).toBe(before);
  expect(await call(work, { operation: 'model.undeclared' })).toMatchObject({
    ok: false,
    code: 'OPERATION_NOT_CATALOGUED',
  });
  expect(await call(work, { operation: NOT_RECONCILABLE.key })).toMatchObject({
    ok: false,
    code: 'EFFECT_NOT_RECONCILABLE',
  });
});

it('AW-01 six facts: the lease carries the delegation the caller resolved', async () => {
  // One agent, two pickups, two live delegations: each lease is only its own.
  const first = await liveWork(s, 'the first pickup', 2_000);
  const second = await liveWork(s, 'the second pickup', 2_000);
  await stepOf(first);
  const seen = world.provider.seen.length;
  for (const delegationId of [String(second.picked['delegationId']), null]) {
    // eslint-disable-next-line no-await-in-loop
    const crossed = await callModel(
      s.db.app,
      s.business,
      { ...caller(first), delegationId },
      requestFor(first),
      broker,
    );
    expect(crossed).toEqual({ ok: false, code: 'LEASE_NOT_OWNED', callId: null });
  }
  expect(world.provider.seen.length).toBe(seen);
  expect(await rowsOnLease(first)).toEqual([]);
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
