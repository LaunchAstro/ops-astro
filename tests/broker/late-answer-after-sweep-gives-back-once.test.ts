// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { grantTo } from '../commands/fixture.ts';
import { endAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { broker, call, gated, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { calls, decider, dispatched, envelopeActual, runOf } from './give-back-world.ts';

useBrokerWorld('solow017giveback');
beforeAll(async () => {
  if (noDatabase) throw new Error('Sol proof requires disposable Postgres');
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
});

it('criterion 4: a late answer after sweep gives back the counted maximum once', async () => {
  const work = await liveWork(s, `Sol counted call ${randomUUID()}`, 900);
  world.provider.mode('answer');
  const delayed = gated(broker);
  const pending = call(work, {}, delayed.broker);
  try {
    await dispatched(work);
    const before = await envelopeActual(work);
    expect(await call(work)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
    const ended = await s.db.app.withBusiness(
      s.business,
      async (tx) => await endAtBudgetStop(tx, decider(s, await runOf(work))),
    );
    expect(ended).toMatchObject({ ok: true, value: { spentMinor: 500 } });
    expect(await envelopeActual(work)).toBe(before + 500);
    // The lease ended at the budget stop while custody still has the call.
    expect(
      await sweepDeployment(s.db.app, () => Promise.resolve(s.business), ['home']),
    ).toMatchObject({ ok: true });
    expect(await calls(work)).toMatchObject([{ state: 'liability_unknown' }]);
    delayed.open();
    await pending;
    expect(await calls(work)).toMatchObject([{ state: 'settled', came_to: '100' }]);
    expect(
      await envelopeActual(work),
      'only the actual 100 stays counted, not the maximum 500',
    ).toBe(before + 100);
  } finally {
    delayed.open();
    await pending;
  }
});
