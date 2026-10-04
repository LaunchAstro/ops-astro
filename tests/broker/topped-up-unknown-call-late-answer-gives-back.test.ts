// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { call, gated, s, useBrokerWorld, world } from './broker-world.ts';
import { dispatched, envelopeActual } from './give-back-world.ts';
import { as, one, people, setThreshold, usePeople } from './budget-answers-world.ts';

// Deliberately no database skip: a missing database is not a review proof.
useBrokerWorld('solow047');
usePeople();

it('criterion 4: a late answer gives back the counted maximum after the sweep marks it unknown', async () => {
  await setThreshold(null);
  const work = await liveWork(s, 'Sol OW-047 late give-back', 900);
  world.provider.mode('answer');
  const before = await envelopeActual(work);
  const slow = gated();
  const pending = call(work, {}, slow.broker);
  try {
    await dispatched(work);
    expect(await call(work)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
    const { run_id: runId, id: askId } = await one<{ run_id: string; id: string }>(
      'select run_id, id from public.budget_asks where lease_id = $1',
      [work.picked['leaseId']],
    );
    expect(
      await s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await topUpAtBudgetStop(tx, {
            ...as(people.approver, runId),
            askId,
            amountMinor: 1000,
            currency: 'AUD',
          }),
      ),
    ).toMatchObject({ ok: true, value: { state: 'applied' } });
    expect(await envelopeActual(work)).toBe(before + 500);
    expect(
      await sweepDeployment(s.db.app, async (key) => (key === 'home' ? s.business : undefined), [
        'home',
      ]),
    ).toMatchObject({ ok: true });
    const { state } = await one<{ state: string }>(
      `select state from public.model_calls where reservation_id = $1 and state <> 'refused'`,
      [work.decision['reservationId']],
    );
    expect(state, 'setup: the released lease makes the still-running call unknown').toBe(
      'liability_unknown',
    );
    slow.open();
    await pending;
    const { actual } = await one<{ actual: string }>(
      `select actual_minor::text as actual from public.model_calls where reservation_id = $1
        and state = 'settled'`,
      [work.decision['reservationId']],
    );
    expect(actual).toBe('100');
    expect(
      await envelopeActual(work),
      'the counted 500 must become the settled 100 exactly once',
    ).toBe(before + 100);
  } finally {
    slow.open();
    await pending;
  }
});
