// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning budget` (U10, ORCH42 (a)): a priced planning reply from the
// owner's own conversation holds its priced maximum on that conversation's
// planning envelope, under the business's planning cap (`budget_caps` key
// `planning`), read under the cap's row lock. No cap set: no planning spend.
// The allowance line (the cap, and what is left) reads before the first
// message; the planning spend (settled plus held) reads beside the plan. A
// failed reply stays held as unknown liability against the envelope. The
// crossings are `aw-04-planning-budget-isolation.test.ts`.

import { expect, it as vitestIt } from 'vitest';
import { callModelForPlanning } from '../../packages/core-custody/src/index.ts';
import type { AdminConnection } from '../../packages/core-records/src/index.ts';
import { racer } from '../runtime/schedules-harness.ts';
import { LOCAL, callCount, noDatabase, s, world } from './broker-world.ts';
import {
  allowance,
  ask,
  local,
  ownerOf,
  p,
  plan,
  rowsFor,
  setCap,
  usePlanningWorld,
} from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04plan');

it('AW-04 planning budget: with no planning cap set, a planning reply is refused and nothing is written or sent', async () => {
  const request = ask(s);
  const before = await callCount();
  const sent = world.provider.seen.length;
  const result = await plan(s, ownerOf(s), request);
  expect(result).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE', callId: null });
  expect(await callCount()).toBe(before);
  expect(world.provider.seen.length).toBe(sent);
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toStrictEqual({
    set: false,
    currency: null,
    limitMinor: 0,
    leftMinor: 0,
    conversation: { spentMinor: 0, heldMinor: 0 },
  });
});

it('AW-04 planning budget: the allowance line reads before the first message, then a priced reply holds its maximum and settles at its price on the envelope', async () => {
  await setCap(s, 1_200);
  const request = ask(s);
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toStrictEqual({
    set: true,
    currency: 'AUD',
    limitMinor: 1_200,
    leftMinor: 1_200,
    conversation: { spentMinor: 0, heldMinor: 0 },
  });
  world.provider.mode('answer');
  const result = await plan(s, ownerOf(s), request);
  expect(result).toMatchObject({ ok: true, reservedMinor: 500 });
  const actual = result.ok ? result.actualMinor : -1;
  expect(actual).toBeGreaterThan(0);
  const [row, ...more] = await rowsFor(s, request.conversation.id);
  expect(more).toStrictEqual([]);
  expect(row).toMatchObject({ state: 'settled', reserved_minor: '500', run_id: null });
  expect(row?.['planning_envelope_id']).toEqual(expect.any(String));
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toMatchObject({
    leftMinor: 1_200 - actual,
    conversation: { spentMinor: actual, heldMinor: 0 },
  });
});

it('AW-04 planning budget: a failed reply stays held at its maximum against the envelope, and the next reply that no longer fits is refused', async () => {
  const request = ask(s);
  const before = await allowance(s, s.decider.personId, request.conversation.id);
  world.provider.mode('costly');
  expect(await plan(s, ownerOf(s), request)).toMatchObject({
    ok: false,
    code: 'LIABILITY_UNKNOWN',
    heldMinor: 500,
  });
  world.provider.mode('answer');
  const after = await allowance(s, s.decider.personId, request.conversation.id);
  expect(after).toMatchObject({
    leftMinor: before.leftMinor - 500,
    conversation: { spentMinor: 0, heldMinor: 500 },
  });
  // Leave one short of a reply's maximum: refused, nothing written.
  await s.db.admin.execute(
    `update public.budget_caps set limit_minor = limit_minor - $2 + 499
      where business_id = $1 and key = 'planning'`,
    [s.business, after.leftMinor],
  );
  const calls = await callCount();
  expect(await plan(s, ownerOf(s), request)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
  expect(await callCount()).toBe(calls);
});

/** Resolves once `count` backends in this database wait on a lock. */
async function waiting(execute: AdminConnection['execute'], count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // The activity view is read once per transaction unless its snapshot is cleared.
    // eslint-disable-next-line no-await-in-loop
    await execute('select pg_stat_clear_snapshot()');
    // eslint-disable-next-line no-await-in-loop
    const [row] = await execute<{ n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(row?.n) >= count) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('the two replies never met');
}

it('AW-04 planning budget: two replies racing for the last of the allowance, on two connections at once: one holds, one is refused', async () => {
  // One reply's maximum (500) and less than the replay's price (100): the
  // second cannot fit whether the first is still held or already settled.
  await setCap(p.bravo, 599);
  world.provider.mode('answer');
  const second = racer(p.bravo);
  // Two operations on two routes, so only the cap's lock stands between them;
  // a blocker holds both at the envelope's insert until both have decided.
  const single = { ...local(p.bravo), routes: [{ ...LOCAL, key: 'on_premises_2' }] };
  try {
    const results = await p.bravo.db.admin.transaction(async (execute) => {
      await execute('lock table public.planning_envelopes in exclusive mode');
      const both = Promise.all([
        plan(p.bravo, ownerOf(p.bravo), ask(p.bravo)),
        callModelForPlanning(
          second,
          p.bravo.business,
          ownerOf(p.bravo),
          {
            ...ask(p.bravo),
            operation: 'model.replay_single',
          },
          single,
        ),
      ]);
      await waiting(execute, 2);
      return { both };
    });
    const codes = (await results.both).map((result) => (result.ok ? 'held' : result.code));
    expect(codes.toSorted()).toStrictEqual(['BUDGET_UNAVAILABLE', 'held']);
  } finally {
    await second.close();
  }
});
