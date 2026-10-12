// SPDX-License-Identifier: AGPL-3.0-only
//
// A receipt names the settlement the ledger holds (`core-runtime/src/receipt.ts`).
// An observation settles its hold at the attempt's own cost plus the hold's
// settled model calls (`settleAtObserved`), and the reservation and envelope
// carry that total, while the attempt row keeps its own cost alone. So the
// receipt reads the spend from the reservation: with a model call settled on
// the hold, it reports what the observation and the ledger report, never the
// attempt's cost with the call's spend handed back as released.

import { expect, it as vitestIt } from 'vitest';
import { appliedDetail } from './schedules-harness.ts';
import { PRICED, t2dHarness } from './t2d-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('receiptcalls');

const { work, applied, observeOf, money, receiptOf } = t2dHarness(() => s);

/** What the synthetic comment is priced at (`PRICED`, the price book). */
const COMMENT_COST = 1_800;

it("a receipt's settlement counts the hold's settled model calls, as the observation and ledger do", async () => {
  const w = await work();
  world.provider.mode('answer');
  const called = await call(w);
  if (!called.ok) throw new Error(`the priced replay call was refused ${called.code}`);
  await applied(w);

  const observed = appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
  const ledger = await money(w);
  const spent = Number(ledger?.['actual']);
  expect(spent).toBeGreaterThan(COMMENT_COST);
  expect(observed['settlement']).toStrictEqual({
    state: 'settled',
    heldMinor: 2_500,
    spentMinor: spent,
    releasedMinor: 2_500 - spent,
  });

  const receipt = await receiptOf(w.attemptId);
  if (!('receipt' in receipt)) throw new Error(`receipt refused ${JSON.stringify(receipt)}`);
  expect(receipt.receipt.settlement).toStrictEqual(observed['settlement']);
});
