// SPDX-License-Identifier: AGPL-3.0-only
//
// A completed handback refuses success for a step-level unknown (design R2,
// "Success refuses"): a step marked dispatched that nothing has accounted
// for. The attempt's own observation accounts for it once it settles: the
// operation register holds the applied effect and the settlement priced its
// cost, so the attempt is `settled` and nothing about it is unknown. That
// handback writes its one success, and the cost is counted once.
//
// A mark nothing settled stays unknown and is still refused, with nothing
// written: an observation that priced nothing (no usage reported), a settled
// step whose outcome stayed `unknown` (what a person's write-off leaves), and a
// legacy `observed` mark with no dispatch behind it, as an import leaves one.
//
// The race of the same observation and handback on separate backends is
// `tests/runtime/observe-counts-the-holds-calls.test.ts`.

import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asAgent,
  codeOf,
  handbackBody,
  rows,
} from '../runtime/schedules-harness.ts';
import { OVER, PRICED, t2dHarness, type Work } from '../runtime/t2d-harness.ts';
import { noDatabase, s, useBrokerWorld } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('r2observed');

const { work, applied, observeOf, money } = t2dHarness(() => s);

/** What the synthetic comment is priced at (`PRICED`, the price book). */
const COMMENT_COST = 1_800;

const handBack = async (w: Work): ReturnType<typeof asAgent> =>
  await asAgent(s, handbackBody(w.picked), w.credential);

/** Everything a handback could write for this attempt. */
const footprintOf = async (w: Work) => ({
  outcomes: await rows<{ outcome: string; end_code: string }>(
    s,
    `select outcome, end_code from public.run_outcomes where business_id = $1 and attempt_id = $2`,
    [s.business, w.attemptId],
  ),
  reports: await rows(
    s,
    `select 1 from public.handback_reports where business_id = $1 and lease_id = $2`,
    [s.business, w.picked['leaseId']],
  ),
  lease: await rows<{ state: string }>(
    s,
    'select state from public.leases where business_id = $1 and id = $2',
    [s.business, w.picked['leaseId']],
  ),
  money: await money(w),
});

it("a completed handback after the attempt's own settled observation writes one success, the cost counted once", async () => {
  const w = await work();
  await applied(w);
  expect(
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe')['settlement'],
  ).toMatchObject({ state: 'settled', spentMinor: COMMENT_COST });

  const handed = await handBack(w);

  expect(codeOf(handed), 'the handback commits').toBe('applied');
  const after = await footprintOf(w);
  expect(after.outcomes).toEqual([{ outcome: 'success', end_code: 'COMPLETED' }]);
  expect(after.reports).toHaveLength(1);
  expect(after.money).toMatchObject({
    state: 'actual',
    actual: String(COMMENT_COST),
    attempt_state: 'settled',
    envelope_actual: String(COMMENT_COST),
  });
});

it('an observation that priced nothing leaves the step unknown: success refused, nothing written', async () => {
  const w = await work();
  await applied(w);
  expect(appliedDetail(await observeOf(w), 'task.observe')['settlement']).toMatchObject({
    state: 'unpriced',
  });
  const before = await footprintOf(w);
  expect(before.money, 'setup: observed, nothing settled').toMatchObject({
    observed: true,
    attempt_state: 'dispatched',
  });

  expect(codeOf(await handBack(w))).toBe('TRANSITION_NOT_PERMITTED');
  expect(await footprintOf(w)).toEqual(before);
});

it('an observed step settled with its outcome unknown, as a write-off leaves it, is refused success', async () => {
  const w = await work();
  await applied(w);
  // Above the hold, the observation keeps the whole hold as an unknown liability.
  expect(codeOf(await observeOf(w, { usage: OVER }))).toBe('BUDGET_UNAVAILABLE');
  // What a person's write-off writes to the attempt (`recovery/write-off.ts`), its mark kept.
  await s.db.admin.execute(
    `update public.attempts
        set observed = true, state = 'settled', actual_minor = 2500, outcome = 'unknown',
            settled_at = now()
      where business_id = $1 and id = $2 and state = 'liability_unknown'`,
    [s.business, w.attemptId],
  );
  const before = await footprintOf(w);
  expect(before.money, 'setup: written off, its outcome unknown').toMatchObject({
    observed: true,
    attempt_state: 'settled',
    outcome: 'unknown',
  });

  expect(codeOf(await handBack(w))).toBe('TRANSITION_NOT_PERMITTED');
  expect(await footprintOf(w)).toEqual(before);
});

it('a legacy observed mark with no dispatch behind it is refused success, nothing written', async () => {
  const w = await work();
  await s.db.admin.execute(
    `update public.attempts set observed = true, state = 'quarantined'
      where business_id = $1 and id = $2`,
    [s.business, w.attemptId],
  );
  const before = await footprintOf(w);

  expect(codeOf(await handBack(w))).toBe('TRANSITION_NOT_PERMITTED');
  expect(await footprintOf(w)).toEqual(before);
});
