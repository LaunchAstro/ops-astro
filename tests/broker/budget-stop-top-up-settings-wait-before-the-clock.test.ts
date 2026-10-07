// SPDX-License-Identifier: AGPL-3.0-only
//
// A top-up at a budget stop reads the four-eyes band under its locks. It may
// wait on a first settings install; a billing grant that ends during that wait
// no longer counts, so the answer holds the band before it reads its clock.

import { expect, it as vitestIt } from 'vitest';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { racer } from '../runtime/schedules-harness.ts';
import {
  grantsEndSoon,
  pastGrantsBehindInstall,
  withoutSettings,
} from '../runtime/settings-install-held.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { as, moneyOf, people, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('stop_topup_settings_wait');
usePeople();

it('a top-up at a budget stop refuses once the billing grant ends during the settings install wait', async () => {
  const { runId } = await stopped('stop top-up settings wait');
  const before = await moneyOf(runId);
  await withoutSettings(s);
  // The plan approver: while they hold billing:decide, they approve a top-up.
  const restore = await grantsEndSoon(s, people.approver.personId);
  const answerer = racer(s);
  try {
    const answered = await pastGrantsBehindInstall(
      s,
      people.approver.personId,
      async () =>
        await answerer.withBusiness(
          s.business,
          async (tx) =>
            await topUpAtBudgetStop(tx, {
              ...as(people.approver, runId),
              amountMinor: 100,
              currency: 'AUD',
            }),
        ),
    );
    expect(answered.ok ? 'applied' : answered.refusal.code).toBe('SCOPE_NOT_GRANTED');
  } finally {
    await answerer.close();
    await restore();
  }
  expect(await moneyOf(runId)).toEqual(before);
}, 60_000);
