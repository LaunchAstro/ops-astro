// SPDX-License-Identifier: AGPL-3.0-only
//
// #2289: a person's `happened` stops the step's replacements, but never one
// whose broker model call is already in flight, as a write-off leaves it
// (S2282-2). The pass proves the first attempt absent and reserves a
// replacement; a worker picks it up and starts a model call through the
// production broker, with no `task.dispatch`. While custody holds the request,
// a person records that the first attempt happened. The replacement keeps its
// hold and lease, so the call's later answer at 150 is charged on that hold,
// inside the envelope, and once the worker is stopped the envelope carries the
// first hold's spend and the 150 once each. With no call out, `happened` still
// stops the replacement and gives its hold back.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { appliedDetail, openSchedules, type Schedules } from './schedules-harness.ts';
import { closedWhileTheReplacementsCallIsOut } from './replacement-call-in-flight-world.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import type { Work } from './t2d-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn(
    'runtime/a-replacements-in-flight-model-call-stays-budgeted-when-the-original-happened: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;
const h = t3d1Harness(() => s);

beforeAll(async () => {
  if (url === undefined) return;
  s = await openSchedules('replacement_call_happened', 1_000_000);
  await openBilling(s);
  // The manager who stops the worker at the end.
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** What the first attempt's hold held: `happened` spends it whole. */
const firstHeld = async (w: Work) =>
  String((await h.holds(w)).find((hold) => hold['attempt_id'] === w.attemptId)?.['held']);

describe.skipIf(url === undefined)(
  "a replacement's in-flight model call stays budgeted when the original happened",
  { timeout: 60_000 },
  () => {
    it('recorded as happened while the call is out, the answer at 150 is charged once inside the envelope', async () => {
      let spent = '';
      const { seen, stopped } = await closedWhileTheReplacementsCallIsOut(s, h, async (w) => {
        appliedDetail(await h.outcome(w, 'happened'), 'budget.record_outcome');
        spent = await firstHeld(w);
      });
      const live = { state: 'held', actual: null, lease_state: 'live', call_actual: null };
      // The envelope still holds the replacement's 2500, which carries the call, and the first
      // hold's spend; the answer moves neither, so it is never counted twice.
      const held = { held: '2500', actual: spent, maximum: '5000' };
      expect(seen).toStrictEqual({
        whileOut: { hold: { ...live, call_state: 'dispatched' }, envelope: held },
        answer: true,
        answered: { hold: { ...live, call_state: 'settled', call_actual: '150' }, envelope: held },
      });
      // Stopped, the replacement settles at its call's 150 and gives the rest back.
      expect(await stopped()).toMatchObject({
        hold: { state: 'actual', actual: '150', call_state: 'settled', call_actual: '150' },
        envelope: { held: '0', actual: String(Number(spent) + 150) },
      });
    });

    it('recorded as happened with no call out, the replacement is stopped and its hold goes back', async () => {
      const w = await h.unknownStep({ applied: false, room: true });
      expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'absent' }]);
      const replacement = await h.replacement(w);
      appliedDetail(await h.outcome(w, 'happened'), 'budget.record_outcome');
      const stoppedHold = (await h.holds(w)).find((hold) => hold['id'] === replacement);
      expect(stoppedHold).toMatchObject({ state: 'abandoned', attempt_state: 'abandoned' });
      expect(await h.envelope(w)).toMatchObject({ held: '0', actual: await firstHeld(w) });
    });
  },
);
