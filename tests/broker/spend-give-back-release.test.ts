// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #756: a call still reserved, never sent, that a top-up or the end
// at a budget stop counted at its maximum gives that maximum back when it is
// released unsent, once, whichever path releases it:
// - its own start, retried after the hold moved on (`markStarted`);
// - the lost-worker sweep, once its lease ran out (`holdLostCalls`);
// - the model-call sweep, once its lease ended (`sweepModelCalls`).
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
import { asAgent, codeOf, liveWork, type Work } from '../runtime/schedules-harness.ts';
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
  await openBilling(s);
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

const topUp = async (work: Work) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...decider(s, await runOf(work)),
        amountMinor: 1_000,
        currency: 'AUD',
      }),
  );

const end = async (work: Work) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) => await endAtBudgetStop(tx, decider(s, await runOf(work))),
  );

const expireLease = async (work: Work): Promise<void> => {
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [work.picked['leaseId']],
  );
};

const sweepWorkers = async (): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => await sweepLostWorkers(tx));
};

const sweepCalls = async (): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
};

it('a counted call released at its retried start gives its maximum back once', async () => {
  const { work, before, request, reserved } = await stoppedUnsent();
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

it('a counted call the lost-worker sweep releases gives its maximum back once', async () => {
  const { work, before } = await stoppedUnsent();
  expect(await topUp(work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);
  await expireLease(work);

  await sweepWorkers();

  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  await sweepWorkers();
  await sweepCalls();
  expect(await envelopeActual(work), 'given back once').toBe(before);
});

it('a counted call the model-call sweep releases gives its maximum back once', async () => {
  const { work, before } = await stoppedUnsent();
  expect(await end(work)).toMatchObject({ ok: true, value: { spentMinor: 500 } });
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);
  await expireLease(work);

  await sweepCalls();

  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  await sweepCalls();
  await sweepWorkers();
  expect(await envelopeActual(work), 'given back once').toBe(before);
});
