// SPDX-License-Identifier: AGPL-3.0-only
//
// C60 egress before route (LF-5): the per-client model-egress check runs
// before a route is chosen, so a model call on a task whose client has model
// use off never reaches any route, local or cloud, and is refused as its step. A
// client's model use is off by default and, while no local-model path exists,
// cannot be switched on (owner line 72), so every client-scoped task is off.
// Where the setting is stored leans on the client record (C32, SL09 U18);
// the check reads the task's own client link, which exists.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { reserveModelCall, sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { awaitParked, liveWork, racer, type Work } from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  LOCAL,
  broker,
  call,
  callCount,
  caller,
  noDatabase,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  withRoutes,
  world,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('c60egress');

/**
 * Link the task to a client as `task.set_party` stores it, by the owner: the
 * link lives in the record's data and the spine's client slot is projected
 * from it (0005's trigger recomputes every slot, so a slot written directly
 * does not survive). The slot is read back, so a pass is never a task with no
 * client.
 */
async function forClient(work: Work): Promise<void> {
  const client = randomUUID();
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [work.taskId, client],
  );
  const [linked] = await s.db.admin.execute<{ client: string | null }>(
    'select uuid_7::text as client from public.records where id = $1',
    [work.taskId],
  );
  expect(linked?.client).toBe(client);
}

it('C60 egress before route: a task whose client has model use off reaches no route, and says why', async () => {
  const work = await liveWork(s, 'c60 a client task', 2_000);
  await forClient(work);
  const calls = await callCount();
  const seen = world.provider.seen.length;
  const answer = await call(work, {}, withRoutes([LOCAL, CLOUD]));
  expect(answer).toMatchObject({ ok: false, code: 'CLIENT_MODEL_USE_OFF' });
  // The refusal is the run's step, as AW-01's refusals are: one refused row,
  // no route, nothing held, and the provider asked nothing.
  const callId = answer.ok ? null : (answer.callId ?? null);
  expect(await rowsOf(callId)).toMatchObject([
    {
      state: 'refused',
      refusal_code: 'CLIENT_MODEL_USE_OFF',
      route_key: null,
      reserved_minor: '0',
    },
  ]);
  expect(await callCount()).toBe(calls + 1);
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it('C60 egress before route: a task with no client is not stopped by the client check', async () => {
  const work = await liveWork(s, 'c60 an internal task', 2_000);
  const answer = await call(work, {}, withRoutes([CLOUD]));
  expect(answer).toMatchObject({ ok: true });
}, 120_000);

it('C60 race: a client put on the task between the hold and the start releases the call unsent', async () => {
  const work = await liveWork(s, 'c60 gains a client after the hold', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
  );
  if (!reserving.ok) throw new Error(`reserve refused ${reserving.code}`);
  await forClient(work);
  const sent = await sendReservedCall(
    s.db.app,
    s.business,
    caller(work),
    requestFor(work),
    reserving.reserved,
    broker,
  );
  expect(sent).toEqual({
    ok: false,
    code: 'CLIENT_MODEL_USE_OFF',
    callId: reserving.reserved.callId,
  });
  expect(world.provider.seen.length).toBe(seen);
  expect(await rowsOf(reserving.reserved.callId)).toMatchObject([
    { state: 'released', started_at: null },
  ]);
}, 120_000);

it('C60 race: a call waits on a client link in flight, then refuses on it', async () => {
  const work = await liveWork(s, 'c60 a link in flight', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  // The link is written and held uncommitted on a connection of its own, as
  // a `task.set_party` still in its transaction holds it.
  const linker = racer(s);
  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let written!: () => void;
  const ready = new Promise<void>((resolve) => {
    written = resolve;
  });
  const linking = linker.withBusiness(s.business, async (tx) => {
    await tx.query(
      `update public.records set data = data || jsonb_build_object('client', $3::text)
        where business_id = $1 and id = $2`,
      [s.business, work.taskId, randomUUID()],
    );
    written();
    await gate;
  });
  try {
    await ready;
    const answering = call(work, {}, withRoutes([LOCAL, CLOUD]));
    // Parked on the task row: the call decides nothing until the link commits.
    await awaitParked(s, 'records', 1);
    commit();
    await linking;
    const answer = await answering;
    expect(answer).toMatchObject({ ok: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(world.provider.seen.length).toBe(seen);
  } finally {
    commit();
    await linking.catch(() => {});
    await linker.close();
  }
}, 120_000);
