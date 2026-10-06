// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { reserveModelCall, sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { endAtBudgetStop, topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { liveWork, racer, type Work } from '../runtime/schedules-harness.ts';
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
import { calls, decider, envelopeActual, runOf } from './give-back-world.ts';

useBrokerWorld('sol940race');
beforeAll(async () => {
  if (noDatabase) throw new Error('Sol proof requires disposable Postgres');
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
});

async function stoppedUnsent(): Promise<Work> {
  const work = await liveWork(s, `Sol unsent race ${randomUUID()}`, 900);
  world.provider.mode('answer');
  await stepOf(work);
  const reserved = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
  );
  expect(reserved.ok).toBe(true);
  expect(await call(work)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  expect(await calls(work)).toMatchObject([{ state: 'reserved', reserved: '500' }]);
  return work;
}

for (const answer of ['top-up', 'end'] as const) {
  it(`${answer} racing an unsent sweep returns the counted maximum`, async () => {
    const work = await stoppedUnsent();
    const before = await envelopeActual(work);
    const request = decider(s, await runOf(work));
    const other = racer(s);
    let arrived: (() => void) | undefined;
    let resume: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // Real SQL on separate backends. Pause only after spentOn has read the
    // reserved maximum, with the answer's envelope and hold locks retained.
    const pending = other.withBusiness(s.business, async (tx) => {
      const paused = {
        ...tx,
        query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
          const rows = await tx.query<Row>(sql, parameters);
          if (sql.includes('as spent') && sql.includes('from public.model_calls')) {
            arrived?.();
            await gate;
          }
          return rows;
        },
      };
      return answer === 'top-up'
        ? await topUpAtBudgetStop(paused, { ...request, amountMinor: 1_000, currency: 'AUD' })
        : await endAtBudgetStop(paused, request);
    });
    try {
      await reached;
      await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
      expect(await calls(work), 'the concurrent sweep released the unsent call').toMatchObject([
        { state: 'released' },
      ]);
      resume?.();
      expect(await pending).toMatchObject({ ok: true });
      // Retrying the sweep cannot recover a refund for an already closed call.
      await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
      expect(await envelopeActual(work), 'an unsent call consumes no actual budget').toBe(before);
    } finally {
      resume?.();
      await pending;
      await other.close();
    }
  });
}
