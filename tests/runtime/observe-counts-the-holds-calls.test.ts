// SPDX-License-Identifier: AGPL-3.0-only
//
// An observation closes its reservation as the classifier would (RUNTIME.md,
// "The model call's ledger"): the hold's settled model calls are part of what
// it spent, and a call sent and never settled keeps the whole hold for a person.
// Before this, `settleAtObserved` priced the attempt alone, so a settled call's
// spend vanished from the envelope and the cap (#832).
//
// And the observation takes the envelope before the lease, in the contract's
// order, so it cannot deadlock against a hand-back that holds the envelope and
// waits on the lease (#834). The race runs on separate backends, with a third
// connection holding the reservation so each side is parked where the cycle
// forms.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asAgent,
  handbackBody,
  holdRows,
  racer,
  rows,
  scalar,
} from './schedules-harness.ts';
import { PRICED, t2dHarness, type Work } from './t2d-harness.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { call, gated, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('obscalls');

const { work, applied, observeOf, money } = t2dHarness(() => s);

const pause = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** Poll `ready` every 25 ms, by default at most 400 times: a schedule the test waits on. */
const until = async (ready: () => Promise<boolean>, tries = 400): Promise<void> => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    if (await ready()) return;
    // eslint-disable-next-line no-await-in-loop
    await pause(25);
  }
};

/** What the synthetic comment is priced at (`PRICED`, the price book). */
const COMMENT_COST = 1_800;

const callsOn = async (w: Work): Promise<{ settled: number; states: string[] }> => {
  const found = await rows<{ state: string; actual: string | null }>(
    s,
    `select state, actual_minor::text as actual from public.model_calls
      where business_id = $1 and reservation_id = $2 order by accepted_at, id`,
    [s.business, w.decision['reservationId']],
  );
  return {
    settled: found.reduce((sum, one) => sum + Number(one.actual ?? 0), 0),
    states: found.map((one) => one.state),
  };
};

const settledCall = async (): Promise<Work> => {
  const w = await work();
  world.provider.mode('answer');
  const result = await call(w);
  if (!result.ok) throw new Error(`the priced replay call was refused ${result.code}`);
  return w;
};

it("an observation's settlement counts the hold's settled model calls", async () => {
  const w = await settledCall();
  const calls = await callsOn(w);
  expect(calls.states).toStrictEqual(['settled']);
  expect(calls.settled).toBeGreaterThan(0);
  await applied(w);

  const observed = appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');

  const spent = COMMENT_COST + calls.settled;
  expect(observed['settlement']).toMatchObject({ state: 'settled', spentMinor: spent });
  expect(await money(w)).toMatchObject({
    state: 'actual',
    actual: String(spent),
    attempt_state: 'settled',
    attempt_actual: String(COMMENT_COST),
    envelope_held: '0',
    envelope_actual: String(spent),
  });
});

it('a model call lost mid-flight keeps the whole hold at observation', async () => {
  const w = await work();
  world.provider.mode('cut');
  await call(w);
  world.provider.mode('answer');
  expect((await callsOn(w)).states).toStrictEqual(['liability_unknown']);
  await applied(w);
  const before = await money(w);

  const observed = appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');

  expect(observed['settlement']).toMatchObject({ state: 'liability_unknown' });
  expect(await money(w)).toMatchObject({
    state: 'held',
    actual: null,
    attempt_state: 'liability_unknown',
    envelope_held: before?.['envelope_held'],
    envelope_actual: before?.['envelope_actual'],
  });
});

it('a model call still with the provider keeps the whole hold at observation', async () => {
  const w = await work();
  world.provider.mode('answer');
  const custody = gated();
  const inFlight = call(w, {}, custody.broker);
  try {
    await until(async () => (await callsOn(w)).states.join() === 'dispatched');
    expect((await callsOn(w)).states).toStrictEqual(['dispatched']);
    await applied(w);
    const before = await money(w);

    const observed = appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');

    expect(observed['settlement']).toMatchObject({ state: 'liability_unknown' });
    expect(await money(w)).toMatchObject({
      state: 'held',
      attempt_state: 'liability_unknown',
      envelope_held: before?.['envelope_held'],
      envelope_actual: before?.['envelope_actual'],
    });
  } finally {
    custody.open();
    await inFlight;
  }
});

/** Backends waiting on any lock in this database. */
const waiting = async (): Promise<number> =>
  await scalar(
    s,
    `select count(*)::text as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`,
    [],
  );

const observeOn = async (w: Work, database: Database): Promise<unknown> =>
  await asAgent(
    s,
    {
      operationId: randomUUID(),
      leaseId: w.picked['leaseId'],
      fence: w.picked['fence'],
      command: 'task.observe',
      attemptId: w.attemptId,
      usage: PRICED,
    },
    w.credential,
    database,
  ).catch((error: unknown) => error);

/**
 * Deadlocks PostgreSQL has broken in this database. The command entry retries a 40P01 victim
 * once (`register-store.ts`), so the outcomes alone can hide one; the server's own count cannot.
 * A backend reports it when it exits, so the racers are closed before it is read.
 */
const deadlocks = async (): Promise<number> =>
  await scalar(
    s,
    `select deadlocks::text as n from pg_stat_database where datname = current_database()`,
    [],
  );

it('an observation and a hand-back on one lease finish without a deadlock, the cost counted once', async () => {
  const w = await work();
  await applied(w);
  // A third connection holds the reservation: the observation parks on it holding the step and
  // the lease, and the hand-back parks behind whichever of the envelope or lease is taken.
  const before = await deadlocks();
  const holder = await holdRows(s, 'reservations', [String(w.decision['reservationId'])]);
  const [observing, handing] = [racer(s), racer(s)];
  let observed: unknown;
  try {
    const observation = observeOn(w, observing);
    await until(async () => (await waiting()) >= 1);
    const handback = asAgent(s, handbackBody(w.picked), w.credential, handing).catch(
      (error: unknown) => error,
    );
    await until(async () => (await waiting()) >= 2);
    expect(await waiting()).toBe(2);

    await holder.release();
    [observed] = await Promise.all([observation, handback]);
  } finally {
    await observing.close();
    await handing.close();
  }

  await until(async () => (await deadlocks()) > before, 120);
  expect(await deadlocks()).toBe(before);
  expect(appliedDetail(observed as never, 'task.observe')['settlement']).toMatchObject({
    state: 'settled',
    spentMinor: COMMENT_COST,
  });
  expect(await money(w)).toMatchObject({
    state: 'actual',
    actual: String(COMMENT_COST),
    envelope_actual: String(COMMENT_COST),
  });
});
