// SPDX-License-Identifier: AGPL-3.0-only
//
// The reconciliation pass settles a held step by the one rule observation uses (#832, security
// read SEC1 M1): when the register proves the effect present, the hold closes at the book's
// price plus what its settled model calls cost, never at the book's price alone. Before this
// the pass called `settleAtObserved` with no calls, so a call already paid to the provider left
// the envelope and the cap.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { rows } from './schedules-harness.ts';
import { t2dHarness } from './t2d-harness.ts';
import { t3bHarness } from './t3b-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('reconcalls');

beforeAll(async () => {
  if (!noDatabase) await openBilling(s);
});

const synthetic = t2dHarness(() => s);
const t3b = t3bHarness(() => s);
const pass = t3d1Harness(() => s);

/** The book's price for the one synthetic comment (`PRICED`). */
const BOOK = 1_800;

it("a present effect settles the hold at the book's price plus its settled model calls", async () => {
  const w = await synthetic.work();
  world.provider.mode('answer');
  const called = await call(w);
  if (!called.ok) throw new Error(`the priced replay call was refused ${called.code}`);
  const [calls] = await rows<{ spent: string }>(
    s,
    `select coalesce(sum(actual_minor), 0)::text as spent from public.model_calls
      where business_id = $1 and reservation_id = $2 and state = 'settled'`,
    [s.business, w.decision['reservationId']],
  );
  const spent = Number(calls?.spent ?? 0);
  expect(spent).toBeGreaterThan(0);
  await synthetic.applied(w);
  await t3b.expire(w);
  await t3b.sweep();

  expect(await pass.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'present' }]);

  expect(await synthetic.money(w)).toMatchObject({
    state: 'actual',
    actual: String(BOOK + spent),
    attempt_actual: String(BOOK),
    envelope_held: '0',
    envelope_actual: String(BOOK + spent),
  });
});
