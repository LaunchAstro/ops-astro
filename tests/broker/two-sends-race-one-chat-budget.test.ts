// SPDX-License-Identifier: AGPL-3.0-only
//
// Two paid sends race one AI chat budget with room for one. Both wait on the
// budget's row lock together, then go on: exactly one holds and is sent, the
// other is refused with no row and no request, and committed never passes
// the limit. A budget lowered while a send waits on that lock refuses only
// the send that holds after it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { HOLD, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('two sends race one chat budget', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_budget_race', undefined, 2);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  /** Waits until `n` backends wait on the budget's row: on its holder, or queued behind each other. */
  async function waitersOf(n: number): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const found = await p.w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%from public.budget_caps%'`,
        [],
      );
      if (found >= n) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${String(n)} backends never waited on the budget`);
  }

  const capRow = async (
    execute: (sql: string, parameters?: readonly unknown[]) => Promise<unknown>,
  ) => {
    await execute(
      `select 1 from public.budget_caps where business_id = $1 and key = 'planning' for update`,
      [p.w.fixture.business],
    );
  };

  it('room for one: one hold, one refusal, one request, committed within the limit', async () => {
    const { db } = p.w.fixture;
    await p.setCap(HOLD + (await p.committed()));
    const first = await p.question('What is due today?');
    const second = await p.question('What is overdue?');
    const sent = p.openrouter.received.length;
    const holder = await hold(db, capRow);
    const pools = [0, 1].map(() => connect(db.appUrl, { source: 'runtime' }));
    const replies = Promise.all([
      p.ask(first, undefined, pools[0]),
      p.ask(second, undefined, pools[1]),
    ]);
    await waitersOf(2);
    await holder.letGo();
    const answers = await replies;
    expect(answers.filter((reply) => reply?.answered === true)).toHaveLength(1);
    expect(
      answers.filter((reply) => reply?.answered === false && reply.code === 'BUDGET_UNAVAILABLE'),
    ).toHaveLength(1);
    const rows = [
      ...(await p.calls(first.conversationId)),
      ...(await p.calls(second.conversationId)),
    ];
    expect(rows).toHaveLength(1);
    expect(p.openrouter.received.length - sent).toBe(1);
    const [cap] = await db.admin.execute<{ readonly limit_minor: string }>(
      `select limit_minor::text from public.budget_caps where business_id = $1 and key = 'planning'`,
      [p.w.fixture.business],
    );
    expect(await p.committed()).toBeLessThanOrEqual(Number(cap?.limit_minor));
    await Promise.all(pools.map(async (pool) => await pool.close()));
  });

  it('a budget lowered while a send waits refuses only the send that holds after it', async () => {
    const { db, business } = p.w.fixture;
    await p.setCap(2 * HOLD + (await p.committed()));
    const early = await p.question('First question?');
    expect(await p.ask(early)).toMatchObject({ answered: true });
    const late = await p.question('Second question?');
    const lowered = (await p.committed()) + 1;
    const holder = await hold(db, capRow, async (execute) => {
      await execute(
        `update public.budget_caps set limit_minor = $2 where business_id = $1 and key = 'planning'`,
        [business, lowered],
      );
    });
    const reply = p.ask(late);
    await waitersOf(1);
    await holder.letGo();
    expect(await reply).toMatchObject({ answered: false, code: 'BUDGET_UNAVAILABLE' });
    expect(await p.calls(late.conversationId)).toHaveLength(0);
    expect(await p.calls(early.conversationId)).toMatchObject([{ state: 'settled' }]);
  });
});
