// SPDX-License-Identifier: AGPL-3.0-only
//
// The reconciliation pass settles a held step by the one rule observation uses (#832, security
// read SEC1 M1): when the register proves the effect present, the hold closes at the book's
// price plus what its settled model calls cost, never at the book's price alone. Before this
// the pass called `settleAtObserved` with no calls, so a call already paid to the provider left
// the envelope and the cap.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { codeOf, rows } from './schedules-harness.ts';
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

  const [answered] = await pass.reconcile();
  expect(answered).toMatchObject({ attemptId: w.attemptId, answer: 'present' });
  expect(answered?.reason).toContain(String(BOOK + spent));

  expect(await synthetic.money(w)).toMatchObject({
    state: 'actual',
    actual: String(BOOK + spent),
    attempt_actual: String(BOOK),
    envelope_held: '0',
    envelope_actual: String(BOOK + spent),
  });
});

// A call on the hold that was never settled leaves the hold to a person even when the register
// proves the effect present, and the pass says that is why, not that the book cannot price it.
// B2's order (register 87): the effect, then the cut, then the sweep. The cut's unknown settlement
// ends the attempt, releases its lease and retires its delegation (`broker-settle.ts:269-271`,
// `broker-stop.ts:122-133`; docs/current-decisions.md:79-81), so the lease is no longer expired
// here (removed `t3b.expire`: there is no live lease left to run out) and the agent is refused.
it('a present effect on a hold with an unsettled model call is left whole, naming the call', async () => {
  const w = await synthetic.work();
  await synthetic.applied(w);
  const unspent = await synthetic.money(w);
  world.provider.mode('cut');
  await call(w);
  world.provider.mode('answer');
  await t3b.sweep();
  const before = await synthetic.money(w);
  expect(before).toMatchObject({ state: 'held', held: unspent?.['held'], actual: null });
  expect(before).toMatchObject({ attempt_state: 'liability_unknown' });
  expect(
    await rows(
      s,
      `select outcome, end_code from public.run_outcomes where business_id = $1 and attempt_id = $2`,
      [s.business, w.attemptId],
    ),
  ).toStrictEqual([{ outcome: 'unknown_provider_outcome', end_code: 'LIABILITY_UNKNOWN' }]);
  expect(codeOf(await synthetic.observeOf(w))).toBe('DELEGATION_NOT_LIVE');

  const [answered] = await pass.reconcile(async () => await Promise.resolve(true));

  expect(answered).toMatchObject({ attemptId: w.attemptId, answer: 'unanswered' });
  expect(answered?.reason).toContain('never settled');
  expect(await synthetic.money(w)).toStrictEqual(before);
});
