// SPDX-License-Identifier: AGPL-3.0-only
//
// The transaction wrapper's half of `tenancy_conformance`: the barrier holding
// between two real businesses, the setting living and dying inside one
// transaction, and the statement log showing the application changed no
// schema. It runs against its own fresh database, migrated from empty.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { randomUUID } from 'node:crypto';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'tenancy wrapper: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('tenancy_conformance: the wrapper', () => {
  let db: FreshDatabase;
  const alpha = randomUUID();
  const beta = randomUUID();

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'a' });
    const add = (id: string, key: string): Promise<void> =>
      db.app.withBusiness(id, async (tx) => {
        await tx.query('insert into businesses (business_id, id, key, name) values ($1,$1,$2,$3)', [
          id,
          key,
          key,
        ]);
      });
    await add(alpha, 'alpha');
    await add(beta, 'beta');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('one business, and no other', () => {
    it('shows a business its own row and no other', async () => {
      const seen = await db.app.withBusiness(alpha, (tx) =>
        tx.query<{ readonly key: string }>('select key from businesses'),
      );
      expect(seen.map((row) => row.key)).toStrictEqual(['alpha']);
    });

    it('finds nothing for another business by its real identifier', async () => {
      const seen = await db.app.withBusiness(alpha, (tx) =>
        tx.query('select key from businesses where id = $1', [beta]),
      );
      expect([...seen]).toStrictEqual([]);
    });

    it('refuses a write that would land in another business', async () => {
      await expect(
        db.app.withBusiness(alpha, async (tx) => {
          await tx.query(
            'insert into businesses (business_id, id, key, name) values ($1,$1,$2,$3)',
            [beta, 'smuggled', 'Smuggled'],
          );
        }),
      ).rejects.toThrow(/row-level security/iu);
    });

    it('refuses a business identifier that is not one, before the server sees it', async () => {
      await expect(
        db.app.withBusiness("' or true --", (tx) => tx.query('select 1')),
      ).rejects.toThrow(/is not a business identifier/u);
    });

    it('sets the business inside the transaction and not before it', () => {
      const runtime = db.log.entries.filter((entry) => entry.source === 'runtime');
      const begin = runtime.findIndex((entry) => /^begin/iu.test(entry.text));
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(runtime[begin + 1]?.text).toMatch(/set_config\('app\.business_id', \$1, true\)/u);
    });

    it('leaves no setting behind on the connection it used', async () => {
      const raw = connectAsAdmin(db.appUrl, { source: 'probe', max: 1 });
      try {
        await raw.transaction(async (execute) => {
          await execute(`select set_config('app.business_id', $1, true)`, [alpha]);
          const inside = await execute<{ readonly value: string | null }>(
            `select current_setting('app.business_id', true) as value`,
          );
          expect(inside[0]?.value).toBe(alpha);
        });
        const after = await raw.execute<{ readonly value: string | null }>(
          `select current_setting('app.business_id', true) as value`,
        );
        expect(after[0]?.value ?? '').toBe('');
      } finally {
        await raw.close();
      }
    });
  });

  describe('no runtime DDL', () => {
    it('has sent no schema-changing statement from the application', () => {
      const offenders = db.log
        .schemaChanging()
        .filter((entry) => entry.source === 'runtime')
        .map((entry) => `${entry.kind}: ${entry.text}`);
      expect(offenders).toStrictEqual([]);
    });

    it('has a statement log that is not empty, so the assertion above means something', () => {
      expect(db.log.entries.filter((entry) => entry.source === 'runtime').length).toBeGreaterThan(
        5,
      );
      expect(db.log.schemaChanging().some((entry) => entry.source === 'migration')).toBe(true);
    });

    it('is refused by the server when it tries anyway', async () => {
      await expect(
        db.app.withBusiness(randomUUID(), (tx) =>
          tx.query('create table public.runtime_ddl (id uuid primary key)'),
        ),
      ).rejects.toThrow(/permission denied/iu);
    });

    it('runs the application as a role with no way around row security', async () => {
      const rows = await db.admin.execute<{
        readonly rolsuper: boolean;
        readonly rolbypassrls: boolean;
        readonly can_create: boolean;
      }>(
        `select rolsuper, rolbypassrls,
                has_schema_privilege(rolname, 'public', 'CREATE') as can_create
           from pg_roles where rolname = $1`,
        [db.loginRole],
      );
      expect(rows[0]).toStrictEqual({ rolsuper: false, rolbypassrls: false, can_create: false });
    });
  });
});
