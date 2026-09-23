// SPDX-License-Identifier: AGPL-3.0-only
//
// T05, the pooled crossover. Two businesses, two real task operations, one
// physical backend.
//
// `tenancy-wrapper.test.ts` already shows the setting dying with its
// transaction on a handle a test drives directly. That is not this. The
// failure T05 names is a *pooled* one: business A's operation finishes,
// the pool hands the same backend to business B, and something A left on the
// session is still there when B arrives. Proving it needs the same physical
// connection under both operations, and needs to look at that connection
// between them -- the only place the question can be asked, because B's own
// `SET LOCAL` writes over whatever was left behind before B can read it.
//
// So: one pool of size 1, `pg_backend_pid()` recorded at every step so reuse
// is observed rather than assumed, and `betweenTransactions` -- the harness's
// single door onto the pooled connection outside the wrapper -- used for the
// no-setting reads and writes.
//
// The operations are `task.create` through `executeCommand`, which is the
// production path, not a hand-written insert.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectObserved,
  type ObservedPool,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createStatementLog } from '../../packages/core-records/src/tenancy/statements.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'pooled crossover: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

interface Tenant {
  readonly businessId: string;
  readonly member: Member;
}

describe.skipIf(serverUrl === undefined)('T05: crossover on one pooled backend', () => {
  let db: FreshDatabase;
  let pool: ObservedPool;
  const log = createStatementLog();
  /** Every backend this run touched through the pool. One entry, or the test is not T05. */
  const backends: number[] = [];
  let alpha: Tenant;
  let beta: Tenant;

  /** The backend the pool is on right now, seen from inside the wrapper. */
  const backendInside = async (businessId: string): Promise<number> => {
    const seen = await pool.withBusiness(businessId, (tx) =>
      tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid'),
    );
    const pid = Number(seen[0]?.pid);
    backends.push(pid);
    return pid;
  };

  /** The backend the pool is on right now, seen between transactions. */
  const backendBetween = async (): Promise<number> => {
    const seen = await pool.betweenTransactions<{ readonly pid: number }>(
      'select pg_backend_pid() as pid',
    );
    const pid = Number(seen[0]?.pid);
    backends.push(pid);
    return pid;
  };

  /** What the pooled connection is carrying with no transaction open. */
  const settingBetween = async (): Promise<string> => {
    const seen = await pool.betweenTransactions<{ readonly value: string | null }>(
      `select current_setting('app.business_id', true) as value`,
    );
    return seen[0]?.value ?? '';
  };

  const tasksVisibleBetween = async (): Promise<number> => {
    const seen = await pool.betweenTransactions<{ readonly n: string }>(
      'select count(*)::text as n from records',
    );
    return Number(seen[0]?.n ?? -1);
  };

  const enrolTenant = async (key: string): Promise<Tenant> => {
    const businessId = await insertBusiness(pool, key);
    await installSpine(pool, businessId);
    const member = await enrol(pool, businessId, `${key}-worker`);
    await pool.withBusiness(businessId, async (tx) => {
      await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'assign');
    });
    return { businessId, member };
  };

  /** A real production operation: `task.create` through the command envelope. */
  const createTask = async (tenant: Tenant, title: string): Promise<string> => {
    const made = await executeCommand(pool, tenant.businessId, tenant.member.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Parameters<typeof executeCommand>[4]);
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    return made.recordId ?? '';
  };

  const titlesSeenBy = async (tenant: Tenant): Promise<readonly string[]> =>
    await pool.withBusiness(tenant.businessId, async (tx) => {
      const rows = await tx.query<{ readonly title: string | null }>(
        `select data->>'title' as title from records where business_id = $1 order by 1`,
        [tenant.businessId],
      );
      return rows.map((row) => row.title ?? '').filter((title) => title !== '');
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'x' });
    // The pool under test. `max: 1` is the whole apparatus: one backend, so
    // every operation below reuses the connection the one before it released.
    pool = connectObserved(db.appUrl, { source: 'runtime', log, max: 1 });
    alpha = await enrolTenant('alpha');
    beta = await enrolTenant('beta');
  }, 120_000);

  afterAll(async () => {
    await pool?.close();
    await db?.drop();
  });

  describe('the two operations really do share a backend', () => {
    it('sees one backend from inside the wrapper, for both businesses', async () => {
      const first = await backendInside(alpha.businessId);
      const second = await backendInside(beta.businessId);
      expect(second).toBe(first);
    });

    it('sees that same backend between the transactions, so the probe is not a third connection', async () => {
      const inside = await backendInside(alpha.businessId);
      expect(await backendBetween()).toBe(inside);
    });
  });

  describe('after A commits', () => {
    let alphaTask: string;

    beforeAll(async () => {
      alphaTask = await createTask(alpha, 'alpha commits');
      await backendBetween();
    });

    it('created a real task for A', async () => {
      expect(alphaTask).toMatch(/^[0-9a-f-]{36}$/u);
      expect(await titlesSeenBy(alpha)).toContain('alpha commits');
    });

    it('leaves no tenant setting on the connection it used', async () => {
      expect(await settingBetween()).toBe('');
    });

    it('leaves nothing readable on that connection with no tenant set', async () => {
      expect(await tasksVisibleBetween()).toBe(0);
    });

    it('gives B a connection that shows B its own work and none of A', async () => {
      await createTask(beta, 'beta after a commit');
      const seen = await titlesSeenBy(beta);
      expect(seen).toContain('beta after a commit');
      expect(seen).not.toContain('alpha commits');
    });
  });

  describe('after A rolls back', () => {
    beforeAll(async () => {
      // A real rollback: the work is done and then the transaction throws, so
      // the wrapper's commit never runs.
      await expect(
        pool.withBusiness(alpha.businessId, async (tx) => {
          await tx.query(
            `insert into records (business_id, id, record_type_id, data)
               select $1, $2, rt.id, jsonb_build_object('title', 'alpha rolls back')
                 from record_types rt where rt.business_id = $1 and rt.key = 'task'`,
            [alpha.businessId, randomUUID()],
          );
          throw new Error('A gives up after writing');
        }),
      ).rejects.toThrow('A gives up after writing');
      await backendBetween();
    });

    it('left nothing of A behind, for A itself', async () => {
      expect(await titlesSeenBy(alpha)).not.toContain('alpha rolls back');
    });

    it('leaves no tenant setting on the connection it used', async () => {
      expect(await settingBetween()).toBe('');
    });

    it('gives B a connection that shows B no row of A, committed or not', async () => {
      const seen = await titlesSeenBy(beta);
      expect(seen).not.toContain('alpha rolls back');
      expect(seen).not.toContain('alpha commits');
      expect(seen).toContain('beta after a commit');
    });
  });

  describe('a read with no tenant setting fails closed', () => {
    it('returns no row from any tenant table', async () => {
      // One at a time, on purpose: the pool holds one connection, and the
      // point of the loop is what that one connection answers with nothing
      // set on it. Promise.all would queue them on the same backend anyway
      // and lose the order the evidence is read in.
      for (const table of ['businesses', 'records', 'people', 'operations']) {
        // oxlint-disable-next-line no-await-in-loop
        const rows = await pool.betweenTransactions<{ readonly n: string }>(
          `select count(*)::text as n from ${table}`,
        );
        expect({ table, n: Number(rows[0]?.n) }).toStrictEqual({ table, n: 0 });
      }
    });

    it('refuses a write rather than landing it under a null tenant', async () => {
      await expect(
        pool.betweenTransactions(
          `insert into businesses (business_id, id, key, name) values ($1, $1, $2, $3)`,
          [randomUUID(), 'no-tenant-set', 'No tenant set'],
        ),
      ).rejects.toThrow(/row-level security/iu);
    });
  });

  // The assertions above are only worth anything if they can fail. A
  // session-wide setting is the exact defect T05 is written against, so it is
  // made here on purpose, through the same door, and caught.
  describe('the crossover assertions are not vacuous', () => {
    it('catches a setting that outlives its transaction', async () => {
      await pool.betweenTransactions(`select set_config('app.business_id', $1, false)`, [
        alpha.businessId,
      ]);
      try {
        expect(await settingBetween()).toBe(alpha.businessId);
        expect(await tasksVisibleBetween()).toBeGreaterThan(0);
      } finally {
        await pool.betweenTransactions(`select set_config('app.business_id', '', false)`);
      }
      expect(await settingBetween()).toBe('');
      expect(await tasksVisibleBetween()).toBe(0);
    });
  });

  describe('what the pool actually did', () => {
    it('used one backend and no other for every step above', () => {
      expect([...new Set(backends)]).toHaveLength(1);
      expect(backends.length).toBeGreaterThan(4);
    });

    it('logged real runtime work and changed no schema', () => {
      const runtime = log.entries.filter((entry) => entry.source === 'runtime');
      expect(runtime.length).toBeGreaterThan(20);
      expect(
        runtime.filter((entry) => entry.kind === 'ddl' || entry.kind === 'opaque'),
      ).toStrictEqual([]);
      expect(
        runtime.some((entry) => /set_config\('app\.business_id', \$1, true\)/u.test(entry.text)),
      ).toBe(true);
    });
  });
});
