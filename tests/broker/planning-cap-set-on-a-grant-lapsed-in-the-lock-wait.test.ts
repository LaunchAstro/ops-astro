// SPDX-License-Identifier: AGPL-3.0-only
//
// `budget.set_planning_cap` is let in by `billing:decide`, asked before the
// handler waits on the cap row's lock. A grant that lapses during that wait
// must not set the cap: the setter asks again once it holds the row, at the
// clock read then, and writes nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  asPerson,
  codeOf,
  openSchedules,
  racer,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('broker/planning-cap-set-on-a-grant-lapsed: DATABASE_URL is unset, so nothing ran.');
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('cap_lapse', 1_000_000);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

async function capLimit(): Promise<string | undefined> {
  const [cap] = await s.db.admin.execute<{ limit_minor: string }>(
    `select limit_minor::text from public.budget_caps
      where business_id = $1 and key = 'planning'`,
    [s.business],
  );
  return cap?.limit_minor;
}

/** The cap at 3000, and the decider's `billing:decide` ending two seconds from now. */
async function lapsingCapSetter(): Promise<void> {
  const grantId = await s.db.app.withBusiness(
    s.business,
    async (tx) => await grantTo(tx, s.decider, 'decide', undefined, false, 'billing'),
  );
  await s.db.admin.execute(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', 3000, 'AUD')`,
    [s.business, randomUUID()],
  );
  await s.db.admin.execute(
    `update public.grants set expires_at = now() + interval '2 seconds' where id = $1`,
    [grantId],
  );
}

describe.skipIf(serverUrl === undefined)('a planning cap set across a lock wait', () => {
  it('refuses a setter whose billing grant lapses while it waits on the cap row, and the cap stays where it was', async () => {
    await lapsingCapSetter();
    const holder = racer(s);
    const setterDb = racer(s);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const holding = holder.withBusiness(s.business, async (tx) => {
        await tx.query(
          `select id from public.budget_caps
            where business_id = $1 and key = 'planning' for update`,
          [s.business],
        );
        await held;
      });
      const body = { command: 'budget.set_planning_cap', limitMinor: 700, fromLimitMinor: 3000 };
      const setter = asPerson(s, { ...body, operationId: randomUUID(), currency: 'AUD' }, setterDb);
      await new Promise((resolve) => {
        setTimeout(resolve, 2500);
      });
      release();
      await holding;
      expect(codeOf(await setter)).toBe('SCOPE_NOT_GRANTED');
    } finally {
      await holder.close();
      await setterDb.close();
    }
    expect(await capLimit()).toBe('3000');
  });
});
