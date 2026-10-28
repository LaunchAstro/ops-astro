// SPDX-License-Identifier: AGPL-3.0-only
//
// S2282-2: a person's write-off stops the step's unmarked replacements
// (#2277), but never one whose broker model call is already in flight. The
// pass proves the first attempt absent and reserves a replacement; a worker
// picks it up and starts a model call through the production broker, with no
// `task.dispatch`. While custody holds the request, a person writes the first
// attempt off at nothing or above. The replacement keeps its hold and lease,
// so the call's later answer at 150 is charged on that hold, inside the
// envelope, and once the worker is stopped the envelope carries the write-off
// and the 150 once each. Custody's answer is stubbed here: no provider is paid.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { appliedDetail, asPerson, openSchedules, type Schedules } from './schedules-harness.ts';
import { closedWhileTheReplacementsCallIsOut } from './replacement-call-in-flight-world.ts';
import { writeOffBody } from './t3c-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn(
    'runtime/a-replacements-in-flight-model-call-stays-budgeted-when-the-original-is-written-off: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;
const h = t3d1Harness(() => s);

beforeAll(async () => {
  if (url === undefined) return;
  s = await openSchedules('replacement_call_in_flight', 1_000_000);
  await openBilling(s);
  // The manager who stops the worker at the end.
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The replacement's worker starts a model call, and `amount` is written off while it is out. */
const writtenOffWhileTheReplacementsCallIsOut = async (amount: number) =>
  await closedWhileTheReplacementsCallIsOut(s, h, async (w) => {
    appliedDetail(await asPerson(s, writeOffBody(w, amount)), 'budget.write_off');
  });

describe.skipIf(url === undefined)(
  "a replacement's in-flight model call stays budgeted when the original is written off",
  { timeout: 60_000 },
  () => {
    it.each([0, 700])(
      'written off at %i while the call is out, the answer at 150 is charged once inside the envelope',
      async (amount) => {
        const { seen: out, stopped } = await writtenOffWhileTheReplacementsCallIsOut(amount);
        const live = { state: 'held', actual: null, lease_state: 'live', call_actual: null };
        // The envelope still holds the replacement's 2500, which carries the call, and the
        // written-off figure; the answer moves neither, so it is never counted twice.
        const held = { held: '2500', actual: String(amount), maximum: '5000' };
        expect(out).toStrictEqual({
          whileOut: { hold: { ...live, call_state: 'dispatched' }, envelope: held },
          answer: true,
          answered: {
            hold: { ...live, call_state: 'settled', call_actual: '150' },
            envelope: held,
          },
        });
        // Stopped, the replacement settles at its call's 150 and gives the rest back.
        expect(await stopped()).toMatchObject({
          hold: { state: 'actual', actual: '150', call_state: 'settled', call_actual: '150' },
          envelope: { held: '0', actual: String(amount + 150) },
        });
      },
    );
  },
);
