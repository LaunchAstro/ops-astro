// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 setter meets the default row` (SL11-26 interim review): the order the
// existing meet case only hopes for, forced. The first planning reply writes
// the default row (AUD 50) and is held at its envelope's insert with that row
// uncommitted; the setter from 5000 then finds no row it can see, inserts, and
// waits on the reply's unique key. The reply commits; the setter's insert does
// nothing and it must compare with the row it finds, 5000, and apply.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { AdminConnection } from '../../packages/core-records/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { asPerson, codeOf, racer, seedSchedules } from '../runtime/schedules-harness.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, ownerOf, plan, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04meet');

/** Resolves once `count` backends in this database wait on a lock. */
async function waiting(execute: AdminConnection['execute'], count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
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
  throw new Error('the reply and the setter never met');
}

it('AW-04 setter meets the default row: a reply holding the uncommitted default row makes the setter take the insert-conflict path, and the setter still applies from 5000', async () => {
  const fresh = await seedSchedules(s.db, 'aw04meet-forced', 1_000_000);
  await fresh.db.app.withBusiness(fresh.business, async (tx) => {
    await grantTo(tx, fresh.decider, 'decide', undefined, false, 'billing');
  });
  world.provider.mode('answer');
  const other = racer(fresh);
  try {
    const both = await fresh.db.admin.transaction(async (execute) => {
      // The reply writes the default row, then waits here at its envelope.
      await execute('lock table public.planning_envelopes in exclusive mode');
      const reply = plan(fresh, ownerOf(fresh), ask(fresh));
      await waiting(execute, 1);
      // The setter cannot see the reply's row: its insert waits on the key.
      const setter = asPerson(
        fresh,
        {
          command: 'budget.set_planning_cap',
          operationId: randomUUID(),
          limitMinor: 700,
          currency: 'AUD',
          fromLimitMinor: 5_000,
        },
        other,
      );
      await waiting(execute, 2);
      return { racing: Promise.all([reply, setter]) };
    });
    const [reply, setter] = await both.racing;
    expect([reply.ok, codeOf(setter)]).toStrictEqual([true, 'applied']);
    const [cap] = await s.db.admin.execute<{ limit_minor: string }>(
      `select limit_minor::text from public.budget_caps
        where business_id = $1 and key = 'planning'`,
      [fresh.business],
    );
    expect(cap?.limit_minor).toBe('700');
  } finally {
    await other.close();
  }
});
