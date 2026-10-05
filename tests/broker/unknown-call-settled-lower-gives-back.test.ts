// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { call, s, useBrokerWorld, world, gated } from './broker-world.ts';
import { calls, decider, dispatched, envelopeActual, runOf } from './give-back-world.ts';

useBrokerWorld('solow016giveback');

it('criterion 4: a counted call that the sweep holds unknown gives back its later lower settlement', async () => {
  await openBilling(s);
  world.provider.mode('answer');
  const work = await liveWork(s, 'solow016 swept giveback', 900);
  const slow = gated();
  const pending = call(work, {}, slow.broker);
  let result;
  try {
    await dispatched(work);
    const before = await envelopeActual(work);
    expect(await call(work)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
    expect(
      await s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await topUpAtBudgetStop(tx, {
            ...decider(s, await runOf(work)),
            amountMinor: 1_000,
            currency: 'AUD',
          }),
      ),
    ).toMatchObject({ ok: true, value: { state: 'applied' } });
    expect(await envelopeActual(work)).toBe(before + 500);
    // The budget stop retired the lease. The real deployment sweep marks
    // the still-running call unknown before its answer arrives.
    await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
    expect(await calls(work)).toMatchObject([{ state: 'liability_unknown' }]);
    slow.open();
    result = await pending;
    const [settled] = await calls(work);
    expect(settled?.state).toBe('settled');
    const actual = Number(settled?.came_to);
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThan(500);
    expect(
      await envelopeActual(work),
      'unknown was counted at 500, so a lower final cost still owes its give-back',
    ).toBe(before + actual);
  } finally {
    slow.open();
    await pending;
  }
  expect(result).toMatchObject({ ok: false });
});
