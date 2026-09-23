// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol 6's three runtime findings at b282216, each through the command entry.
//
// RUNTIME-1: the first approval on a task opens its envelope, and the cap
// behind it is the money ceiling in one currency. A version in another
// currency is refused `CAP_BINDING_MISMATCH` before anything is written, the
// same code an existing envelope in another currency already answers.
//
// RUNTIME-2: a cap limit is a `bigint`, and one above 2^53 is still valid.
// The committed total and the limit are compared as exact integers, so the
// approval that would take the total one unit past the cap is refused
// `BUDGET_EXHAUSTED`. Every total here is read from SQL as text.
//
// RUNTIME-3: `now()` is the transaction's start. A decide or a heartbeat that
// began before a deadline and waited on its lock until after it must judge
// the deadline on the clock read once its locks are held. Each schedule parks
// the command on a row held by another connection, waits until the database
// clock is past the deadline, and only then lets go. No row is back-dated
// past its deadline and nothing sleeps longer than the short deadline itself.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  approveBody,
  asAgent,
  asPerson,
  awaitParked,
  codeOf,
  createTask,
  holdRows,
  liveWork,
  openSchedules,
  proposeBody,
  racer,
  revisionOf,
  rows,
  appliedDetail,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/cap-exact-and-post-lock-clock: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** Everything an approval moves, as exact text, so "nothing moved" is one comparison. */
async function footprint(s: Schedules): Promise<Readonly<Record<string, string>>> {
  const found = await rows<Readonly<Record<string, string>>>(
    s,
    `select
       (select count(*) from public.gate_decisions where business_id = $1)::text as decisions,
       (select count(*) from public.task_envelopes where business_id = $1)::text as envelopes,
       (select count(*) from public.reservations where business_id = $1)::text as reservations,
       (select count(*) from public.attempts where business_id = $1)::text as attempts,
       (select coalesce(sum(held_minor + actual_minor), 0) from public.task_envelopes
         where business_id = $1)::text as total,
       (select string_agg(id::text || ':' || state, ',' order by id) from public.gates
         where business_id = $1) as gates`,
    [s.business],
  );
  return found[0] ?? {};
}

async function proposeWith(
  s: Schedules,
  title: string,
  overrides: Readonly<Record<string, unknown>>,
): Promise<Detail> {
  const taskId = await createTask(s, title);
  const body = { ...proposeBody(taskId, await revisionOf(s, taskId)), ...overrides };
  return appliedDetail(await asPerson(s, body), 'task.propose');
}

/** Poll the database clock, never the test's, until it is past `expiresSql`. */
async function waitPast(s: Schedules, expiresSql: string, id: unknown): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const found = await rows<{ readonly past: boolean }>(
      s,
      `select clock_timestamp() > (${expiresSql}) as past`,
      [id],
    );
    if (found[0]?.past === true) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('the deadline never passed on the database clock');
}

/** The parked command's own transaction began before the deadline it is judged against. */
async function startedBefore(s: Schedules, expiresSql: string, id: unknown): Promise<boolean> {
  const found = await rows<{ readonly before: boolean }>(
    s,
    `select bool_and(a.xact_start < (${expiresSql})) as before
       from pg_stat_activity a
      where a.datname = current_database() and a.wait_event_type = 'Lock'`,
    [id],
  );
  return found[0]?.before === true;
}

describe.skipIf(serverUrl === undefined)(
  'RUNTIME-1: the cap currency binds the first envelope',
  () => {
    let s: Schedules;

    beforeAll(async () => {
      s = await openSchedules('s6cur', 100_000);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('approves AUD under an AUD cap and refuses USD with nothing moved', async () => {
      const aud = await proposeWith(s, 'in the cap currency', { maximumMinor: 1_000 });
      expect(codeOf(await asPerson(s, approveBody(aud)))).toBe('applied');

      const usd = await proposeWith(s, 'in another currency', {
        maximumMinor: 1_000,
        currency: 'USD',
      });
      const before = await footprint(s);
      const answer = await asPerson(s, approveBody(usd));
      expect(codeOf(answer)).toBe('CAP_BINDING_MISMATCH');
      expect(await footprint(s)).toStrictEqual(before);
      const envelopes = await rows<{ readonly currency: string }>(
        s,
        `select distinct currency from public.task_envelopes where business_id = $1`,
        [s.business],
      );
      expect(envelopes.map((row) => row.currency)).toStrictEqual(['AUD']);
    }, 30_000);
  },
);

describe.skipIf(serverUrl === undefined)('RUNTIME-2: a cap above 2^53 is compared exactly', () => {
  /** 2^53 + 1: a valid bigint that a JavaScript number cannot hold. */
  const LIMIT = '9007199254740993';
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('s6big', 1);
    // Set as text, so the parameter never passes through a number.
    await s.db.admin.execute(
      `update public.budget_caps set limit_minor = $3::text::bigint
        where business_id = $1 and id = $2`,
      [s.business, s.capId, LIMIT],
    );
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  async function committed(): Promise<string> {
    const found = await rows<{ readonly n: string }>(
      s,
      `select coalesce(sum(held_minor + actual_minor), 0)::text as n
         from public.task_envelopes where business_id = $1 and cap_id = $2`,
      [s.business, s.capId],
    );
    return found[0]?.n ?? '';
  }

  it('fills the cap exactly and refuses one more unit as exhausted', async () => {
    const first = await proposeWith(s, 'the largest safe hold', {
      maximumMinor: Number.MAX_SAFE_INTEGER,
    });
    expect(codeOf(await asPerson(s, approveBody(first)))).toBe('applied');
    const second = await proposeWith(s, 'the last two units', { maximumMinor: 2 });
    expect(codeOf(await asPerson(s, approveBody(second)))).toBe('applied');
    expect(await committed()).toBe(LIMIT);

    const third = await proposeWith(s, 'one unit past the cap', { maximumMinor: 1 });
    const before = await footprint(s);
    const answer = await asPerson(s, approveBody(third));
    expect(codeOf(answer)).toBe('BUDGET_EXHAUSTED');
    expect(await footprint(s)).toStrictEqual(before);
    expect(await committed()).toBe(LIMIT);
    const gate = await rows<{ readonly state: string }>(
      s,
      `select state from public.gates where business_id = $1 and id = $2`,
      [s.business, third['gateId']],
    );
    expect(gate[0]?.state).toBe('pending');
  }, 30_000);
});

describe.skipIf(serverUrl === undefined)('RUNTIME-3: expiry is judged after the lock wait', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('s6clk', 100_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('refuses GATE_EXPIRED to a decide that waited on its gate past the deadline', async () => {
    const proposal = await proposeWith(s, 'decided across its deadline', {
      maximumMinor: 1_000,
      expiresInSeconds: 3,
    });
    const gateExpiry = `select expires_at from public.gates where id = $1`;
    const before = await footprint(s);

    const deciderDb = racer(s);
    const holder = await holdRows(s, 'gates', [proposal['gateId'] as string]);
    let answer;
    try {
      const deciding = asPerson(s, approveBody(proposal), deciderDb);
      await awaitParked(s, 'gates', 1);
      expect(await startedBefore(s, gateExpiry, proposal['gateId'])).toBe(true);
      await waitPast(s, gateExpiry, proposal['gateId']);
      await holder.release();
      answer = await deciding;
    } finally {
      await holder.release().catch(() => undefined);
      await deciderDb.close();
    }

    expect(codeOf(answer)).toBe('GATE_EXPIRED');
    expect(await footprint(s)).toStrictEqual(before);
  }, 30_000);

  it('refuses LEASE_EXPIRED to a heartbeat that waited on its lease past expiry', async () => {
    const { picked } = await liveWork(s, 'renewed across its expiry', 1_000);
    // Three seconds left on the lease and its delegation, on the database clock.
    await s.db.admin.execute(
      `with lease as (
         update public.leases set expires_at = clock_timestamp() + interval '3 seconds'
          where business_id = $1 and id = $2
          returning delegation_id, expires_at)
       update public.delegations d set expires_at = lease.expires_at
         from lease where d.business_id = $1 and d.id = lease.delegation_id`,
      [s.business, picked['leaseId']],
    );
    const leaseExpiry = `select expires_at from public.leases where id = $1`;
    const times = async (): Promise<unknown> =>
      await rows(
        s,
        `select l.expires_at::text as lease, d.expires_at::text as delegation
           from public.leases l
           join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
          where l.business_id = $1 and l.id = $2`,
        [s.business, picked['leaseId']],
      );
    const before = await times();

    const beaterDb = racer(s);
    const holder = await holdRows(s, 'leases', [picked['leaseId'] as string]);
    let answer;
    try {
      const beating = asAgent(
        s,
        {
          command: 'task.heartbeat',
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          leaseSeconds: 600,
        },
        String(picked['credential']),
        beaterDb,
      );
      await awaitParked(s, 'leases', 1);
      expect(await startedBefore(s, leaseExpiry, picked['leaseId'])).toBe(true);
      await waitPast(s, leaseExpiry, picked['leaseId']);
      await holder.release();
      answer = await beating;
    } finally {
      await holder.release().catch(() => undefined);
      await beaterDb.close();
    }

    expect(codeOf(answer)).toBe('LEASE_EXPIRED');
    expect(await times()).toStrictEqual(before);
  }, 30_000);
});
