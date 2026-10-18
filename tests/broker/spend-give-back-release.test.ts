// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #756: a call still reserved, never sent, that a top-up or the end
// at a budget stop counted at its maximum gives that maximum back when it is
// released unsent, once, whichever path releases it:
// - its own start, retried after the hold moved on (`markStarted`);
// - the model-call sweep, its lease ended at the stop (`sweepModelCalls`), and
//   only with its hold and envelope locked: while another transaction holds
//   them it is left for the next pass.
// The lost-worker sweep (`holdLostCalls`) never meets one: a stop releases the
// lease (`broker-wait.ts`), and that sweep finds only live leases run out.
// Through the real broker, top-up, end, pickup and sweeps.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import {
  reserveModelCall,
  sendReservedCall,
  sweepModelCalls,
  type ModelCallRequest,
  type ReservedCall,
} from '../../packages/core-custody/src/index.ts';
import {
  endAtBudgetStop,
  sweepLostWorkers,
  topUpAtBudgetStop,
} from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  asAgent,
  codeOf,
  liveWork,
  pickup,
  racer,
  rows,
  type Work,
} from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import {
  broker,
  call,
  caller,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';
import { calls, decider, envelopeActual, reservationOf, runOf } from './give-back-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('givebackrelease');

beforeAll(async () => {
  if (noDatabase) return;
  // Budget and gate permission for the decider (`billing:decide`, `gate:decide`).
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
}, 120_000);

interface Unsent {
  readonly work: Work;
  /** The envelope's actual before the unsent call was counted. */
  readonly before: number;
  readonly request: ModelCallRequest;
  readonly reserved: ReservedCall;
}

/** 900 holds one call reserved at the replay maximum of 500, never sent, and the next stops the run. */
async function stoppedUnsent(): Promise<Unsent> {
  const work = await liveWork(s, `giveback release ${randomUUID()}`, 900);
  world.provider.mode('answer');
  await stepOf(work);
  const request = requestFor(work);
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, broker),
  );
  if (!reserving.ok) throw new Error(`reserve refused: ${reserving.code}`);
  const before = await envelopeActual(work);
  expect(await call(work)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  return { work, before, request, reserved: reserving.reserved };
}

const topUp = async (work: Work, amountMinor = 1_000) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...decider(s, await runOf(work)),
        amountMinor,
        currency: 'AUD',
      }),
  );

/**
 * #1623 R1 (B2): a stop releases the unsent calls its hold never counted, so a
 * counted unsent call is one a later stop leaves on a hold a top-up already
 * counted (`releaseNeverSent`). 400 holds no call at 500, so the first stops the
 * run; a top-up of 550 makes the hold 950; the work picked up again holds one
 * call reserved at 500, never sent, and the next stops the run again.
 */
async function countedUnsent(): Promise<Unsent> {
  const first = await liveWork(s, `giveback counted ${randomUUID()}`, 400);
  world.provider.mode('answer');
  expect(await call(first)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  expect(await topUp(first, 550)).toMatchObject({ ok: true, value: { heldMinor: '950' } });
  // The pickup re-holds on a fresh reservation (`budget-answer.ts`): the call is read on that one.
  const picked = await pickup(s, reservationOf(first));
  const decision = { ...first.decision, reservationId: picked['reservationId'] };
  const work: Work = { ...first, decision, picked };
  await stepOf(work);
  const request = requestFor(work);
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, broker),
  );
  if (!reserving.ok) throw new Error(`reserve refused: ${reserving.code}`);
  const before = await envelopeActual(work);
  expect(await call(work)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  expect(await calls(work), 'left reserved by the stop').toMatchObject([
    { state: 'reserved', reserved: '500' },
  ]);
  return { work, before, request, reserved: reserving.reserved };
}

const end = async (work: Work) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) => await endAtBudgetStop(tx, decider(s, await runOf(work))),
  );

const sweepWorkers = async (): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => await sweepLostWorkers(tx));
};

const sweepCalls = async (): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
};

it('a counted call released at its retried start gives its maximum back once', async () => {
  // #1623 R1 (B2): the counted unsent call now comes from a second stop on a topped-up hold.
  const { work, before, request, reserved } = await countedUnsent();
  expect(await topUp(work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  const picked = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: reservationOf(work),
    leaseSeconds: 600,
  });
  expect(codeOf(picked)).toBe('applied');
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);

  const started = await sendReservedCall(
    s.db.app,
    s.business,
    caller(work),
    request,
    reserved,
    broker,
  );

  expect(started).toMatchObject({ ok: false, callId: reserved.callId });
  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  await sweepWorkers();
  await sweepCalls();
  expect(await envelopeActual(work), 'given back once').toBe(before);
});

it('a counted call the model-call sweep releases gives its maximum back once', async () => {
  // #1623 R1 (B2): the counted unsent call now comes from a second stop on a topped-up hold.
  const { work, before, request, reserved } = await countedUnsent();
  expect(await end(work)).toMatchObject({ ok: true, value: { spentMinor: '500' } });
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);

  await sweepCalls();

  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  const started = await sendReservedCall(
    s.db.app,
    s.business,
    caller(work),
    request,
    reserved,
    broker,
  );
  expect(started).toMatchObject({ ok: false, callId: reserved.callId });
  await sweepCalls();
  await sweepWorkers();
  expect(await envelopeActual(work), 'given back once').toBe(before);
});

/** The hold's own figure and the envelope's held, read as the administrator. */
const held = async (work: Work): Promise<{ readonly hold: number; readonly envelope: number }> => {
  const [row] = await rows<{ hold: string; envelope: string }>(
    s,
    `select r.held_minor::text as hold, e.held_minor::text as envelope
       from public.reservations r join public.task_envelopes e on e.id = r.envelope_id
      where r.id = $1`,
    [reservationOf(work)],
  );
  return { hold: Number(row?.hold), envelope: Number(row?.envelope) };
};

it('a counted call released at its start while its topped-up hold is still held gives back onto that hold', async () => {
  // #1623 R1 (B2): the counted unsent call now comes from a second stop on a topped-up hold.
  const { work, before, request, reserved } = await countedUnsent();
  expect(await topUp(work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);
  const topped = await held(work);

  const started = await sendReservedCall(
    s.db.app,
    s.business,
    caller(work),
    request,
    reserved,
    broker,
  );

  expect(started).toMatchObject({ ok: false, callId: reserved.callId });
  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  expect(await held(work)).toEqual({ hold: topped.hold + 500, envelope: topped.envelope + 500 });
  await sweepCalls();
  expect(await envelopeActual(work), 'given back once').toBe(before);
});

it('a call released before any top-up or end gives nothing back, and a later top-up does not count it', async () => {
  const { work, before } = await stoppedUnsent();

  await sweepCalls();

  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  expect(await topUp(work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(await envelopeActual(work), 'nothing counted, nothing given').toBe(before);
});

it('a counted call whose hold another transaction holds is left to the next sweep, which gives back once', async () => {
  // #1623 R1 (B2): the counted unsent call now comes from a second stop on a topped-up hold.
  const { work, before } = await countedUnsent();
  expect(await end(work)).toMatchObject({ ok: true, value: { spentMinor: '500' } });
  const other = racer(s);
  let locked: (() => void) | undefined;
  let release: (() => void) | undefined;
  const holding = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = other.withBusiness(s.business, async (tx) => {
    await tx.query(
      'select 1 from public.reservations where business_id = $1 and id = $2 for update',
      [tx.businessId, reservationOf(work)],
    );
    locked?.();
    await gate;
  });
  try {
    await holding;
    await sweepCalls();
    expect(await calls(work), 'skipped while its hold is held').toMatchObject([
      { state: 'reserved' },
    ]);
    expect(await envelopeActual(work)).toBe(before + 500);
  } finally {
    release?.();
    await holder;
    await other.close();
  }

  await sweepCalls();

  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work), 'given back once').toBe(before);
});
