// SPDX-License-Identifier: AGPL-3.0-only
//
// #2288: the pass proves a step's first attempt absent and reserves a
// replacement; a worker picks the replacement up and dispatches it. A person
// then writes the first attempt off, at nothing or above: the replacement,
// already dispatched, is left alone (#2282). Its worker's lease runs out and
// the sweep holds it unknown, and a person records `nothing_happened` on it.
// The write-off wins (#2277): the outcome gives the replacement's hold back but
// resumes nothing, so no fresh hold is reserved for the step, and a pickup of
// any of the step's holds is refused with nothing written and no money moved.
// With no write-off, the same `nothing_happened` resumes the step and a pickup
// runs it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  pickup,
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import type { Work } from './t2d-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn(
    'runtime/a-write-off-wins-over-nothing-happened-on-a-dispatched-replacement: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;
const h = t3d1Harness(() => s);

beforeAll(async () => {
  if (url === undefined) return;
  s = await openSchedules('write_off_wins', 1_000_000);
  await openBilling(s);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/**
 * The step's replacement picked up and dispatched, the first attempt written off at `amount`
 * (none when null), then the replacement held unknown by the sweep: the replacement's work.
 */
async function dispatchedReplacementHeldUnknown(amount: number | null) {
  const w = await h.unknownStep({ applied: false, room: true });
  expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'absent' }]);
  const replacement = await h.replacement(w);
  const picked = await pickup(s, replacement);
  const next: Work = {
    ...w,
    picked,
    credential: String(picked['credential']),
    attemptId: String(picked['attemptId']),
  };
  await h.t2d.dispatched(next);
  if (amount !== null) {
    appliedDetail(await asPerson(s, writeOffBody(w, amount)), 'budget.write_off');
  }
  await h.t3b.expire(next);
  await h.t3b.sweep();
  const held = (await h.holds(w)).find((hold) => hold['attempt_id'] === next.attemptId);
  expect(held).toMatchObject({ state: 'held', attempt_state: 'liability_unknown' });
  return { w, next };
}

/** The step's holds still held, then a pickup of every hold of the step, in any state. */
async function heldThenPickedUp(w: Work) {
  const holds = await h.holds(w);
  const held = holds.filter((hold) => hold['state'] === 'held');
  const picked = [];
  for (const hold of holds) {
    // Sequential: each pickup takes the step's locks.
    // eslint-disable-next-line no-await-in-loop
    const answer = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: hold['id'],
      leaseSeconds: 600,
    });
    picked.push(codeOf(answer));
  }
  return { held: held.map((hold) => hold['held']), picked };
}

describe.skipIf(url === undefined)(
  'a write-off wins over nothing_happened on a replacement dispatched before it',
  { timeout: 60_000 },
  () => {
    it.each([0, 700])(
      'written off at %i, nothing_happened on the replacement resumes nothing and no pickup runs the step',
      async (amount) => {
        const { w, next } = await dispatchedReplacementHeldUnknown(amount);
        const recorded = appliedDetail(
          await h.outcome(next, 'nothing_happened'),
          'budget.record_outcome',
        );
        expect(recorded['resumed']).toBeNull();
        const before = await h.t3b.snapshot();
        const refused = 'RESERVATION_NOT_CLAIMABLE';
        // The first attempt's hold and the replacement's: none held, each pickup refused.
        expect(await heldThenPickedUp(w)).toStrictEqual({ held: [], picked: [refused, refused] });
        expect(await h.t3b.snapshot()).toStrictEqual(before);
      },
    );

    it('with no write-off, nothing_happened on the replacement resumes the step and a pickup runs it', async () => {
      const { w, next } = await dispatchedReplacementHeldUnknown(null);
      appliedDetail(await h.outcome(next, 'nothing_happened'), 'budget.record_outcome');
      // The first attempt is still held unknown beside the fresh hold the outcome reserved.
      const seen = await heldThenPickedUp(w);
      expect(seen.held).toStrictEqual(['2500', '2500']);
      expect(seen.picked.filter((code) => code === 'applied')).toStrictEqual(['applied']);
    });
  },
);
