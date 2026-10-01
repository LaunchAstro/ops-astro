// SPDX-License-Identifier: AGPL-3.0-only
//
// N10-M2 data separation: two businesses, one route. A business at its fair
// share waits for its lookups; that wait is its own, so the other business's
// lookups in the same pass still go, within that business's own share; and
// the other business's lookups take nothing from this one's share, so this
// one's room comes back as soon as its own calls end.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import type { Schedules } from '../runtime/schedules-harness.ts';
import { openSecond } from '../runtime/t3b-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { callsOf, dropped, noDatabase, pass, s, useFaultWorld, world } from './aw-10-world.ts';
import { free, hold, lookups, onRoute } from './aw-10-lookup-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('n10m2iso');

let bravo: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  bravo = await openSecond(s, 'n10m2-iso-bravo');
  await openBilling(bravo);
}, 120_000);

it("N10-M2 isolation: another business's lookups never use this business's share", async () => {
  // A route of 4 with both businesses in flight: a share of 2 each.
  const route = onRoute('n10m2-cross', 4);
  world.provider.lookupMode('honest');
  const ours = await dropped('unavailable', s, route);
  const theirs = await dropped('unavailable', bravo, route);
  await hold(s, route, 2);
  await hold(bravo, route, 1);
  const before = await callsOf(s, ours.work);
  const sent = lookups();
  // This business is asked first: its wait must not hold back bravo's lookup.
  await pass([s, bravo], route);
  expect(lookups()).toBe(sent + 1);
  expect(await callsOf(s, ours.work)).toEqual(before);
  // The positive control: bravo, under its share, asked once and released.
  expect((await callsOf(bravo, theirs.work))[0]).toMatchObject({ state: 'released' });

  // Bravo's lookup took none of this business's share: its own calls ending gives it room.
  await free(s, 'n10m2-cross');
  await pass([s, bravo], route);
  expect(lookups()).toBe(sent + 2);
  expect((await callsOf(s, ours.work))[0]).toMatchObject({ state: 'released' });
});
