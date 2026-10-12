// SPDX-License-Identifier: AGPL-3.0-only
//
// `budget.set_planning_cap` reads the planning cap row under its lock (or
// inserts the first row, waiting on one in flight), asks `billing:decide`
// again once its waits are over, and writes. Every racer here is a connection
// of its own, each is seen parked before the next starts or the holder lets
// go, and a lost reply is a relay cut at a named point of the commit.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waiterOf } from '../support/lock-wait-race.ts';
import {
  asPerson,
  awaitParked,
  codeOf,
  cutProxy,
  holdRows,
  openSchedules,
  racer,
  settle,
  type CutPoint,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let s: Schedules;
let billingGrantId: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('cap_setters', 1_000_000);
  billingGrantId = await s.db.app.withBusiness(
    s.business,
    async (tx) => await grantTo(tx, s.decider, 'decide', undefined, false, 'billing'),
  );
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

const setBody = (limitMinor: number, fromLimitMinor: number) => ({
  command: 'budget.set_planning_cap',
  operationId: randomUUID(),
  limitMinor,
  fromLimitMinor,
  currency: 'AUD',
});

async function planningRows(): Promise<readonly string[]> {
  const rows = await s.db.admin.execute<{ limit_minor: string }>(
    `select limit_minor::text from public.budget_caps
      where business_id = $1 and key = 'planning'`,
    [s.business],
  );
  return rows.map((row) => row.limit_minor);
}

async function planningAt(limitMinor: number | null): Promise<string | undefined> {
  await s.db.admin.execute(
    `delete from public.budget_caps where business_id = $1 and key = 'planning'`,
    [s.business],
  );
  if (limitMinor === null) return undefined;
  const id = randomUUID();
  await s.db.admin.execute(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', $3, 'AUD')`,
    [s.business, id, limitMinor],
  );
  return id;
}

async function appliedSets(operationId: string): Promise<number> {
  const rows = await s.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from public.audit_events
      where business_id = $1 and operation_id = $2 and outcome = 'applied'`,
    [s.business, operationId],
  );
  return rows[0]?.n ?? 0;
}

const outcomeOf = (result: PromiseSettledResult<CommandResult>): string =>
  result.status === 'rejected'
    ? `threw ${String(result.reason)}`
    : isCommandRefusal(result.value)
      ? codeOf(result.value)
      : 'applied';

it('two setters from the same limit at once: the first in the queue sets it, the second is stale', async () => {
  const capId = await planningAt(3000);
  const holder = await holdRows(s, 'budget_caps', [String(capId)]);
  const first = racer(s);
  const second = racer(s);
  try {
    const a = asPerson(s, setBody(700, 3000), first);
    await awaitParked(s, 'budget_caps', 1);
    const b = asPerson(s, setBody(900, 3000), second);
    await awaitParked(s, 'budget_caps', 2);
    await holder.release();
    const [one, two] = await settle([a, b]);
    expect([outcomeOf(one!), outcomeOf(two!)]).toEqual(['applied', 'VERSION_STALE']);
  } finally {
    await first.close();
    await second.close();
  }
  expect(await planningRows()).toEqual(['700']);
});

it('two first setters waiting on a first row in flight: exactly one sets the cap and it is that one', async () => {
  await planningAt(null);
  // A first planning reply writing the default, its row not yet committed.
  const inFlight = await hold(s.db, async (execute) => {
    await execute(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'planning', 5000, 'AUD')`,
      [s.business, randomUUID()],
    );
  });
  const first = racer(s);
  const second = racer(s);
  try {
    const a = asPerson(s, setBody(700, 5000), first);
    await waiterOf(s.db, inFlight);
    const b = asPerson(s, setBody(900, 5000), second);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      const waiting = await s.db.admin.execute<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(a.pid))`,
        [inFlight.pid],
      );
      if ((waiting[0]?.n ?? 0) >= 2) break;
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      await delay(25);
    }
    await inFlight.letGo();
    const results = (await settle([a, b])).map((result) => outcomeOf(result));
    expect(results.toSorted()).toEqual(['VERSION_STALE', 'applied']);
    const winner = results[0] === 'applied' ? '700' : '900';
    expect(await planningRows()).toEqual([winner]);
  } finally {
    await first.close();
    await second.close();
  }
});

it.each<CutPoint>(['before-commit', 'after-commit'])(
  'a setter whose connection is cut %s and retried under the same operation id sets the cap once',
  async (point) => {
    await planningAt(3000);
    const body = setBody(700, 3000);
    const proxy = await cutProxy(s.db.appUrl, point);
    const cut = racer(s, proxy.url);
    try {
      const [interrupted] = await settle([asPerson(s, body, cut)]);
      expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
      expect(interrupted?.status).toBe('rejected');
    } finally {
      // A client whose socket the relay killed may never finish ending: give it a second.
      await Promise.race([cut.close().catch(() => null), delay(1_000)]);
      await proxy.close();
    }
    expect(await planningRows()).toEqual([point === 'after-commit' ? '700' : '3000']);
    const retried = await asPerson(s, body);
    expect(isCommandRefusal(retried)).toBe(false);
    expect(await planningRows()).toEqual(['700']);
    expect(await appliedSets(body.operationId)).toBe(1);
    // The same intent sent again under a new id moves nothing: the cap is no longer 3000.
    expect(codeOf(await asPerson(s, setBody(700, 3000)))).toBe('VERSION_STALE');
    expect(await planningRows()).toEqual(['700']);
  },
);

it('a first setter let in by a first row rolled back, its grant revoked in that wait, writes no row', async () => {
  await planningAt(null);
  const inFlight = await hold(
    s.db,
    async (execute) => {
      await execute(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'planning', 5000, 'AUD')`,
        [s.business, randomUUID()],
      );
    },
    async () => await Promise.reject(new Error('the first reply rolls back')),
  );
  const setterDb = racer(s);
  try {
    const setter = asPerson(s, setBody(700, 5000), setterDb);
    await waiterOf(s.db, inFlight);
    await s.db.admin.execute(
      'update public.grants set revoked_at = clock_timestamp() where id = $1',
      [billingGrantId],
    );
    await inFlight.letGo().catch(() => null);
    expect(codeOf(await setter)).toBe('SCOPE_NOT_GRANTED');
  } finally {
    await setterDb.close();
  }
  expect(await planningRows()).toEqual([]);
});
