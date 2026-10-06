// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10 data separation for a lookup's slot. The slot is on the asked call's
// own row, so it is read and written only in that call's business: another
// business neither sees it nor gives it back. It still counts on the route,
// which is the installation's, through the fair share's one count; the wait
// that causes says nothing of the other business.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { liveWork, type Schedules } from '../runtime/schedules-harness.ts';
import { openSecond } from '../runtime/t3b-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import {
  callIn,
  callsOf,
  dropped,
  noDatabase,
  pass,
  s,
  useFaultWorld,
  world,
} from './aw-10-world.ts';
import { heldLookups, onRoute } from './aw-10-lookup-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('lookupslotiso');

let bravo: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  bravo = await openSecond(s, 'lookupslotiso-bravo');
  await openBilling(bravo);
}, 120_000);

/** `sql` as the application, in `on`'s business. */
const asApp = async (
  on: Schedules,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> =>
  await on.db.app.withBusiness(on.business, async (tx) => await tx.query(sql, [...parameters]));

const SLOTS = `select id::text, lookup_until > clock_timestamp() as slot from public.model_calls
                where id = $1 or lookup_until is not null`;

it("another business's lookup slot does not show in this business's rows", async () => {
  const route = onRoute('slot-iso', 1);
  world.provider.lookupMode('honest');
  const theirs = await dropped('unavailable', bravo, route);
  world.provider.mode('answer');
  const theirCall = String((await callsOf(bravo, theirs.work))[0]?.['id']);
  const held = heldLookups(route);
  const passing = pass(bravo, held.broker);
  await expect.poll(held.arrived).toBe(1);

  // The positive control: bravo's own row carries its slot.
  expect(await asApp(bravo, SLOTS, [theirCall])).toEqual([{ id: theirCall, slot: true }]);
  // This business sees no slot of bravo's, by the call's id or any other way.
  expect(await asApp(s, SLOTS, [theirCall])).toEqual([]);
  // Nor can it give bravo's slot back.
  const freed = `update public.model_calls set lookup_until = null where id = $1 returning id`;
  expect(await asApp(s, freed, [theirCall])).toEqual([]);

  // Bravo's slot holds the route's one place: this business waits, told nothing of bravo.
  const mine = await liveWork(s, 'slot iso waits', 2_000);
  expect(await callIn(s, mine, route)).toStrictEqual({
    ok: false,
    code: 'RATE_LIMITED',
    callId: null,
    retryAfterSeconds: 5,
  });
  held.end('go');
  await passing;
  expect((await callsOf(bravo, theirs.work))[0]).toMatchObject({ state: 'released' });
  expect(await callIn(s, mine, route)).toMatchObject({ ok: true });
});
