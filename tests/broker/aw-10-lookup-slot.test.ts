// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10 and AW-01: a provider lookup in flight holds a slot that the route's
// ceiling, the business's fair share and the business's own ceiling for the
// operation all count, taken in the transaction that found room and before
// anything is sent. It is given back when the lookup ends, custody's throw
// included; a worker lost while asking leaves a slot that stops counting at
// its bound, the operation's timeout plus a margin. Each case has its own
// route, so one case's slots never count in another's.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { liveWork, rows, type Schedules } from '../runtime/schedules-harness.ts';
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
import { free, heldLookups, hold, lookups, onRoute } from './aw-10-lookup-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('lookupslot');

let bravo: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  bravo = await openSecond(s, 'lookupslot-bravo');
  await openBilling(bravo);
}, 120_000);

const WAITED = { ok: false, code: 'RATE_LIMITED', callId: null, retryAfterSeconds: 5 };

it("a lookup in flight takes the route's last slot: a model call on the same route waits", async () => {
  const route = onRoute('slot-last', 1);
  world.provider.lookupMode('honest');
  const run = await dropped('unavailable', s, route);
  world.provider.mode('answer');
  const held = heldLookups(route);
  const passing = pass(s, held.broker);
  await expect.poll(held.arrived).toBe(1);

  const mine = await liveWork(s, 'slot waits', 2_000);
  expect(await callIn(s, mine, route)).toStrictEqual(WAITED);

  held.end('go');
  await passing;
  expect((await callsOf(s, run.work))[0]).toMatchObject({ state: 'released' });
  // The lookup ended: its slot is back and the call goes.
  expect(await callIn(s, mine, route)).toMatchObject({ ok: true });
});

it('two lookups racing for the last slot: one goes, one waits', async () => {
  const route = onRoute('slot-race', 1);
  world.provider.lookupMode('honest');
  const ours = await dropped('unavailable', s, route);
  const theirs = await dropped('unavailable', bravo, route);
  const held = heldLookups(route);
  const sent = lookups();
  let finished = 0;
  const both = [pass(s, held.broker), pass(bravo, held.broker)].map(async (one) => {
    await one;
    finished += 1;
  });
  // Each pass either reached the provider or ended without asking.
  await expect.poll(() => held.arrived() + finished, { timeout: 20_000 }).toBe(2);
  expect(held.arrived()).toBe(1);

  held.end('go');
  await Promise.all(both);
  expect(lookups()).toBe(sent + 1);
  const states = [(await callsOf(s, ours.work))[0], (await callsOf(bravo, theirs.work))[0]].map(
    (call) => call?.['state'],
  );
  expect(states.toSorted()).toEqual(['liability_unknown', 'released']);
});

it('a lookup that throws gives its slot back', async () => {
  const route = onRoute('slot-throws', 1);
  const run = await dropped('unavailable', s, route);
  world.provider.mode('answer');
  const held = heldLookups(route);
  const passing = pass(s, held.broker);
  await expect.poll(held.arrived).toBe(1);
  const mine = await liveWork(s, 'slot after a throw', 2_000);
  expect(await callIn(s, mine, route)).toStrictEqual(WAITED);

  held.end('throw');
  await passing;
  expect((await callsOf(s, run.work))[0]).toMatchObject({
    state: 'liability_unknown',
    reconcile_note: 'could establish nothing: custody could not ask the provider',
  });
  expect(await callIn(s, mine, route)).toMatchObject({ ok: true });
});

it("a lookup in flight counts against the business's own ceiling for the operation", async () => {
  // The operation's ceiling is 4 a business; the route has room for a thousand.
  const roomy = onRoute('slot-own', 1_000);
  world.provider.lookupMode('honest');
  await dropped('unavailable', s, roomy);
  world.provider.mode('answer');
  await hold(s, onRoute('slot-own-other', 1_000), 3);
  const held = heldLookups(roomy);
  const passing = pass(s, held.broker);
  await expect.poll(held.arrived).toBe(1);
  const mine = await liveWork(s, 'slot own ceiling', 2_000);
  expect(await callIn(s, mine, roomy)).toStrictEqual(WAITED);

  held.end('go');
  await passing;
  await free(s, 'slot-own-other');
  expect(await callIn(s, mine, roomy)).toMatchObject({ ok: true });
});

it("a crashed lookup's slot stops counting after its bound", async () => {
  const route = onRoute('slot-crash', 1);
  const run = await dropped('unavailable', s, route);
  world.provider.mode('answer');
  const held = heldLookups(route);
  // The worker asking is lost: its lookup never ends and nothing gives its slot back.
  void pass(s, held.broker);
  await expect.poll(held.arrived).toBe(1);
  const mine = await liveWork(s, 'slot after a crash', 2_000);
  expect(await callIn(s, mine, route)).toStrictEqual(WAITED);

  // The bound is the lookup's timeout (2 s for the replay operation) plus 60 s.
  const lease = run.work.picked['leaseId'];
  const [slot] = await rows<{ left: string }>(
    s,
    `select extract(epoch from lookup_until - clock_timestamp())::text as left
       from public.model_calls where lease_id = $1`,
    [lease],
  );
  expect(Number(slot?.left)).toBeGreaterThan(55);
  expect(Number(slot?.left)).toBeLessThanOrEqual(62);
  // The bound passes.
  await s.db.admin.execute(
    `update public.model_calls set lookup_until = clock_timestamp() - interval '1 second'
      where lease_id = $1`,
    [lease],
  );
  expect(await callIn(s, mine, route)).toMatchObject({ ok: true });
});
