// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6 pooled transactions (the Vercel re-plan, section 11 step 1): behind
// Supabase's transaction pooler one server backend carries many requests'
// transactions, one after another, whichever business each is for. The
// tenant setting is `set_config(..., true)`, local to its transaction, and the
// client prepares no statements, so nothing one request leaves on the backend
// reaches the next. T05 (`pooled-crossover.test.ts`) shows one business's
// operation, then another's; here two requests interleave on the one backend,
// each in two transactions with the other's between them, as a pooler hands
// them out, and the backend is asked what it holds between each. A request
// whose transaction ends badly (a throw, a statement error, a statement
// timeout, a cancellation from another connection) leaves nothing either.
//
// The pool has one connection (`max: 1`), so every transaction below lands on
// the same backend, and `pg_backend_pid()` is recorded to show it did.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectObserved,
  type ObservedPool,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Tenant {
  readonly businessId: string;
  readonly member: Member;
}

interface World {
  readonly db: FreshDatabase;
  readonly pool: ObservedPool;
  readonly alpha: Tenant;
  readonly beta: Tenant;
  /** Every backend pid seen; one, or the pool was not one backend. */
  readonly backends: Set<number>;
}

let world: World | undefined;

const built = (): World => world as World;

async function enrolTenant(pool: ObservedPool, key: string): Promise<Tenant> {
  const businessId = await insertBusiness(pool, key);
  await installSpine(pool, businessId);
  const member = await enrol(pool, businessId, `${key}-worker`);
  await pool.withBusiness(businessId, async (tx) => {
    await grantTo(tx, member, 'write');
  });
  return { businessId, member };
}

/** One request's transaction: `task.create` through the command envelope. */
async function create(tenant: Tenant, title: string): Promise<void> {
  const made = await executeCommand(
    built().pool,
    tenant.businessId,
    tenant.member.presented,
    'api',
    {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Parameters<typeof executeCommand>[4],
  );
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
}

/** One request's other transaction: what it can read, with no business filter of its own. */
async function titles(tenant: Tenant): Promise<readonly string[]> {
  const { pool, backends } = built();
  return await pool.withBusiness(tenant.businessId, async (tx) => {
    const rows = await tx.query<{ readonly title: string | null; readonly pid: number }>(
      `select data->>'title' as title, pg_backend_pid() as pid from records order by 1`,
    );
    for (const row of rows) backends.add(Number(row.pid));
    return rows.map((row) => row.title ?? '').filter((title) => title !== '');
  });
}

/** What the backend holds with no transaction open. */
async function between() {
  const { pool, backends } = built();
  const [row] = await pool.betweenTransactions<{
    readonly setting: string | null;
    readonly prepared: string;
    readonly visible: string;
    readonly pid: number;
  }>(
    `select current_setting('app.business_id', true) as setting,
            (select count(*) from pg_prepared_statements)::text as prepared,
            (select count(*) from records)::text as visible,
            pg_backend_pid() as pid`,
  );
  backends.add(Number(row?.pid));
  return {
    setting: row?.setting ?? '',
    prepared: Number(row?.prepared),
    visible: Number(row?.visible),
  };
}

const CLEAN = { setting: '', prepared: 0, visible: 0 };

describe.skipIf(serverUrl === undefined)('S0-6 pooled transactions', () => {
  beforeAll(async () => {
    const db = await createFreshDatabase({ part: 'pooledi' });
    const pool = connectObserved(db.appUrl, { source: 'runtime', max: 1 });
    world = {
      db,
      pool,
      alpha: await enrolTenant(pool, 'alpha'),
      beta: await enrolTenant(pool, 'beta'),
      backends: new Set(),
    };
  }, 120_000);

  afterAll(async () => {
    await world?.pool.close();
    await world?.db.drop();
  });

  interleavedCase();
  atOnceCase();
  recoveryCase();
});

function interleavedCase() {
  it('two requests interleaved on one backend each see only their own business', async () => {
    const { alpha, beta, backends } = built();
    // A writes, B writes, A reads, B reads: each request's second transaction
    // meets the backend the other request's transaction has just left.
    await create(alpha, 'alpha first');
    expect(await between()).toStrictEqual(CLEAN);
    await create(beta, 'beta first');
    expect(await between()).toStrictEqual(CLEAN);
    expect(await titles(alpha)).toStrictEqual(['alpha first']);
    expect(await between()).toStrictEqual(CLEAN);
    expect(await titles(beta)).toStrictEqual(['beta first']);
    expect(await between()).toStrictEqual(CLEAN);
    expect(backends.size).toBe(1);
  });
}

function atOnceCase() {
  it('requests sent at once queue onto the one backend and still stay apart', async () => {
    const { alpha, beta, backends } = built();
    await Promise.all([
      create(alpha, 'alpha at once 1'),
      create(beta, 'beta at once 1'),
      create(alpha, 'alpha at once 2'),
      create(beta, 'beta at once 2'),
    ]);
    const [seenByAlpha, seenByBeta] = await Promise.all([titles(alpha), titles(beta)]);
    expect(seenByAlpha).toEqual(expect.arrayContaining(['alpha at once 1', 'alpha at once 2']));
    expect(seenByAlpha.every((title) => title.startsWith('alpha '))).toBe(true);
    expect(seenByBeta).toEqual(expect.arrayContaining(['beta at once 1', 'beta at once 2']));
    expect(seenByBeta.every((title) => title.startsWith('beta '))).toBe(true);
    expect(await between()).toStrictEqual(CLEAN);
    expect(backends.size).toBe(1);
  });
}

/** Cancels the backend's sleep from another connection, as a client that gives up does. */
async function cancelWhenAsleep(pid: number, tries = 250): Promise<void> {
  const [row] = await built().db.admin.execute<{ readonly cancelled: boolean }>(
    `select pg_cancel_backend(pid) as cancelled from pg_stat_activity
      where pid = $1 and wait_event = 'PgSleep'`,
    [pid],
  );
  if (row?.cancelled === true) return;
  if (tries === 0) throw new Error('the backend never started its sleep');
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  await cancelWhenAsleep(pid, tries - 1);
}

/** Each way a request's transaction can end badly, and what it ends with. */
const FAULTS: readonly (readonly [string, RegExp, (tx: TenantQuery) => Promise<unknown>])[] = [
  [
    'a throw mid-transaction',
    /thrown mid-transaction/u,
    async (tx) => {
      await tx.query(`select count(*) from records`);
      throw new Error('thrown mid-transaction');
    },
  ],
  ['a statement error', /division by zero/u, async (tx) => await tx.query(`select 1 / 0`)],
  [
    'a statement timeout',
    /statement timeout/u,
    async (tx) => {
      await tx.query(`set local statement_timeout = '50ms'`);
      await tx.query(`select pg_sleep(5)`);
    },
  ],
  [
    'a cancellation',
    /canceling statement due to user request/u,
    async (tx) => {
      const [own] = await tx.query<{ readonly pid: number }>(`select pg_backend_pid() as pid`);
      await Promise.all([tx.query(`select pg_sleep(5)`), cancelWhenAsleep(Number(own?.pid))]);
    },
  ],
];

function recoveryCase() {
  it.each(FAULTS)(
    'after %s, the backend holds nothing and the next request sees only its own business',
    async (_, ended, fault) => {
      const { alpha, beta, backends } = built();
      await expect(built().pool.withBusiness(alpha.businessId, fault)).rejects.toThrow(ended);
      expect(await between()).toStrictEqual(CLEAN);
      const seenByBeta = await titles(beta);
      expect(seenByBeta.length).toBeGreaterThan(0);
      expect(seenByBeta.every((title) => title.startsWith('beta '))).toBe(true);
      expect((await titles(alpha)).every((title) => title.startsWith('alpha '))).toBe(true);
      expect(await between()).toStrictEqual(CLEAN);
      expect(backends.size).toBe(1);
    },
  );
}
