// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs on #762 (PRV-oa-762-R1, criteria 4 and 5), by behaviour: a
// call a top-up or a stop counted at its maximum, then held unknown by the
// sweep, gives back once when a late nothing-happened answer releases it,
// and once when two connections close it at the same time, the second
// waiting on the envelope lock the first holds.
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  reserveModelCall,
  sendReservedCall,
  sweepModelCalls,
} from '../../packages/core-custody/src/index.ts';
import { settle } from '../../packages/core-custody/src/broker-settle.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { endAtBudgetStop, topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import {
  broker,
  call,
  caller,
  gated,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';
import {
  calls,
  decider,
  dispatched,
  envelopeActual,
  heldAtEnvelope,
  reservationOf,
  resumeOnceBlocked,
  runOf,
} from './give-back-world.ts';

useBrokerWorld('countedcloses');
beforeAll(async () => {
  if (noDatabase) throw new Error('Sol proof requires disposable Postgres');
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
});

async function stoppedCall() {
  const work = await liveWork(s, `Sol 762 ${randomUUID()}`, 900);
  await stepOf(work);
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
  );
  if (!held.ok) throw new Error(`setup reserve: ${held.code}`);
  const slow = gated();
  const pending = sendReservedCall(
    s.db.app,
    s.business,
    caller(work),
    requestFor(work),
    held.reserved,
    slow.broker,
  );
  await dispatched(work);
  const before = await envelopeActual(work);
  expect(await call(work)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
  return { work, reserved: held.reserved, pending, open: slow.open, before };
}

async function topUp(work: Work) {
  const runId = await runOf(work);
  expect(
    await s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await topUpAtBudgetStop(tx, { ...decider(s, runId), amountMinor: 1000, currency: 'AUD' }),
    ),
  ).toMatchObject({ ok: true, value: { state: 'applied' } });
}

async function holdFigures(work: Work) {
  return await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query<{ state: string; held: string }>(
        'select state, held_minor::text as held from public.reservations where business_id = $1 and id = $2',
        [tx.businessId, reservationOf(work)],
      ),
  );
}

it.each(['top_up', 'end'] as const)(
  'a late nothing-happened answer gives back a swept maximum counted at a %s, once',
  async (kind) => {
    world.provider.mode('nothing_happened');
    const active = await stoppedCall();
    try {
      if (kind === 'top_up') await topUp(active.work);
      else {
        const runId = await runOf(active.work);
        expect(
          await s.db.app.withBusiness(
            s.business,
            async (tx) => await endAtBudgetStop(tx, decider(s, runId)),
          ),
        ).toMatchObject({ ok: true, value: { spentMinor: 500 } });
      }
      expect(await envelopeActual(active.work)).toBe(active.before + 500);
      const figures = await holdFigures(active.work);
      await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
      expect(await calls(active.work)).toMatchObject([{ state: 'liability_unknown' }]);
      active.open();
      expect(await active.pending).toMatchObject({ code: 'CALL_RELEASED' });
      expect(await envelopeActual(active.work)).toBe(active.before);
      expect(await holdFigures(active.work)).toEqual([
        {
          state: kind === 'top_up' ? 'held' : 'abandoned',
          held: String(Number(figures[0]?.held) + (kind === 'top_up' ? 500 : 0)),
        },
      ]);
      expect(
        await settle(
          s.db.app,
          s.business,
          caller(active.work),
          requestFor(active.work),
          active.reserved,
          { kind: 'nothing', reason: 'duplicate reply' },
          broker,
        ),
      ).toMatchObject({ code: 'DECISION_STALE' });
      expect(await envelopeActual(active.work)).toBe(active.before);
    } finally {
      active.open();
      await active.pending;
    }
  },
);

it('two connections closing a counted unknown call wait on the envelope and give back once', async () => {
  world.provider.mode('answer');
  const active = await stoppedCall();
  const left = heldAtEnvelope(s);
  const close = (db: Database) =>
    settle(
      db,
      s.business,
      caller(active.work),
      requestFor(active.work),
      active.reserved,
      { kind: 'nothing', reason: 'positive proof' },
      broker,
    );
  let closing: Promise<unknown>[] = [];
  try {
    await topUp(active.work);
    await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
    const first = close(left.on.db.app);
    closing = [first];
    await left.reached;
    const contended = resumeOnceBlocked(s, left.resume);
    const second = close(s.db.app);
    closing.push(second);
    expect(await contended, 'the second close waited on the envelope lock').toBe(true);
    expect(await Promise.all([first, second])).toMatchObject([
      { code: 'CALL_RELEASED' },
      { code: 'DECISION_STALE' },
    ]);
    expect(await envelopeActual(active.work)).toBe(active.before);
    active.open();
    expect(await active.pending).toMatchObject({ code: 'DECISION_STALE' });
    expect(await calls(active.work)).toMatchObject([{ state: 'released', came_to: '0' }]);
    expect(await envelopeActual(active.work)).toBe(active.before);
  } finally {
    left.resume();
    active.open();
    await Promise.allSettled([...closing, active.pending]);
    await left.close();
  }
});
