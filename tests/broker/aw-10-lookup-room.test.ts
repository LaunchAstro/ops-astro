// SPDX-License-Identifier: AGPL-3.0-only
//
// N10-M2: the pass's provider lookup goes out under the gate a model call
// takes on its way out (AW-01): the route's ceiling across every business of
// the installation, and the business's fair share of it. A lookup with no room
// is not sent, and the pass writes nothing on the call, so the next pass asks
// again; it never changes a call's state on its own. Another business fills
// the route here, so the ceiling or the share is the only thing in the way;
// in the last case the business's own ceiling for the operation is.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import type { Schedules } from '../runtime/schedules-harness.ts';
import { openSecond } from '../runtime/t3b-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { callsOf, dropped, noDatabase, pass, s, useFaultWorld, world } from './aw-10-world.ts';
import { free, hold, lookups, onRoute } from './aw-10-lookup-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('n10m2room');

let bravo: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  bravo = await openSecond(s, 'n10m2-room-bravo');
  await openBilling(bravo);
}, 120_000);

it('N10-M2: a provider lookup waits when its route is at its ceiling', async () => {
  const full = onRoute('n10m2-full', 1);
  world.provider.lookupMode('honest');
  const run = await dropped('unavailable', s, full);
  // Another business holds the route's one call: this business is under its share.
  await hold(bravo, full, 1);
  const before = await callsOf(s, run.work);
  const sent = lookups();
  await pass(s, full);
  expect(lookups()).toBe(sent);
  // Nothing written: no note, no mode, no state.
  expect(await callsOf(s, run.work)).toEqual(before);
  // The room comes back: the next pass asks.
  await free(bravo, 'n10m2-full');
  await pass(s, full);
  expect(lookups()).toBe(sent + 1);
  expect((await callsOf(s, run.work))[0]).toMatchObject({ state: 'released' });
});

it("N10-M2: a provider lookup takes no more than its business's fair share", async () => {
  // A route of 4 with two businesses in flight: a share of 2 each, and room for a fourth call.
  const shared = onRoute('n10m2-share', 4);
  world.provider.lookupMode('honest');
  const run = await dropped('unavailable', s, shared);
  await hold(bravo, shared, 1);
  await hold(s, shared, 2);
  const before = await callsOf(s, run.work);
  const sent = lookups();
  await pass(s, shared);
  expect(lookups()).toBe(sent);
  expect(await callsOf(s, run.work)).toEqual(before);
  await free(s, 'n10m2-share');
  await pass(s, shared);
  expect(lookups()).toBe(sent + 1);
  expect((await callsOf(s, run.work))[0]).toMatchObject({ state: 'released' });
});

it('N10-M2: a lookup with room asks once and records its proof', async () => {
  const open = onRoute('n10m2-open', 4);
  world.provider.lookupMode('honest');
  const run = await dropped('unavailable', s, open);
  await hold(bravo, open, 1);
  const sent = lookups();
  await pass(s, open);
  expect(lookups()).toBe(sent + 1);
  const [call] = await callsOf(s, run.work);
  expect(call).toMatchObject({ state: 'released' });
  expect(String(call?.['reconcile_note'])).toMatch(/^proved nothing happened: /u);
});

it("a lookup waits at the business's own ceiling for the operation", async () => {
  // The operation's ceiling is 4 a business; the route has room for a thousand.
  const roomy = onRoute('lookup-m1', 1_000);
  world.provider.lookupMode('honest');
  const run = await dropped('unavailable', s, roomy);
  await hold(s, onRoute('lookup-m1-other', 1_000), 4);
  const before = await callsOf(s, run.work);
  const sent = lookups();
  await pass(s, roomy);
  expect(lookups()).toBe(sent);
  expect(await callsOf(s, run.work)).toEqual(before);
  await free(s, 'lookup-m1-other');
  await pass(s, roomy);
  expect(lookups()).toBe(sent + 1);
  expect((await callsOf(s, run.work))[0]).toMatchObject({ state: 'released' });
});
