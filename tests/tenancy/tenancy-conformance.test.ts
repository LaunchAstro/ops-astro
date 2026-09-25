// SPDX-License-Identifier: AGPL-3.0-only
//
// `tenancy_conformance`: the invariant test T1a is split against. It passes
// only with the migration linter and the transaction wrapper both landed, and
// only against a database migrated from empty.
//
// Half of it is negative. A conformance set that has only ever been run
// against a schema that satisfies it has not been shown to notice anything,
// so every rule is broken here on purpose, inside a transaction that is rolled
// back, and the set is required to name the rule it caught.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeFindings,
  lintCompositeKeys,
  tenancyConformance,
  type Finding,
} from '../../packages/core-records/src/tenancy/conformance.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { migrate } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverUrl = databaseUrlFromEnvironment();

// The migrations on disk, read here rather than listed, so the next migration
// needs no edit to this suite (docs/local/DATA.md: "No number here or in any
// suite says which migration is the last one").
const onDisk = readdirSync('migrations')
  .filter((name) => name.endsWith('.sql'))
  .toSorted()
  .map((name) => name.slice(0, -'.sql'.length));

// A skipped suite that looks like a passing one is the failure this whole part
// exists to prevent, so say it out loud rather than showing a green tick.
if (serverUrl === undefined) {
  console.warn(
    'tenancy_conformance: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

class Rollback extends Error {}

/** Break a rule, read the catalogue, and leave no trace. DDL is transactional. */
async function whenSchemaIs(
  admin: AdminConnection,
  breakage: string,
  check: (findings: readonly Finding[]) => void,
): Promise<void> {
  try {
    await admin.transaction(async (execute) => {
      await execute(breakage);
      check(await tenancyConformance(execute));
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

function rules(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => finding.rule);
}

describe.skipIf(serverUrl === undefined)('tenancy_conformance', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'a' });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('the migrations', () => {
    it('finds the migrations on disk numbered from 0001 with no gap', () => {
      expect(onDisk.length).toBeGreaterThan(0);
      expect(onDisk.map((version) => version.slice(0, 4))).toStrictEqual(
        Array.from({ length: onDisk.length }, (_, i) => String(i + 1).padStart(4, '0')),
      );
    });

    it('applies every migration to a database created empty', () => {
      expect(db.migration.applied).toStrictEqual(onDisk);
      expect(db.migration.alreadyApplied).toStrictEqual([]);
    });

    it('applies nothing on a second run', async () => {
      const again = await migrate(db.admin, 'migrations');
      expect(again.applied).toStrictEqual([]);
      expect(again.alreadyApplied).toStrictEqual(onDisk);
    });

    it('refuses a migration whose file changed after it was applied', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'tenancy-'));
      const original = readFileSync('migrations/0001_tenancy.sql', 'utf8');
      writeFileSync(join(directory, '0001_tenancy.sql'), `${original}\n-- edited after the fact\n`);
      await expect(migrate(db.admin, directory)).rejects.toThrow(/applied as .* but the file now/u);
    });

    it('leaves the ledger outside the application tables', async () => {
      const rows = await db.admin.execute<{ readonly count: string }>(
        `select count(*)::text as count from information_schema.tables
          where table_schema = 'public' and table_name = 'schema_migrations'`,
      );
      expect(rows[0]?.count).toBe('0');
    });
  });

  describe('the conformance set', () => {
    it('is green on the migrated schema', async () => {
      const findings = await tenancyConformance(db.admin.execute);
      expect(describeFindings(findings)).toBe('');
      expect(findings).toStrictEqual([]);
    });

    it('catches a table with no business_id, no index, no row security and no policy', async () => {
      await whenSchemaIs(
        db.admin,
        'create table public.leaky (id uuid primary key)',
        (findings) => {
          expect(rules(findings)).toStrictEqual(
            expect.arrayContaining([
              'business_id uuid not null on every application table',
              'business_id is indexed on every application table',
              'row security enabled and forced on every application table',
              'exactly one restrictive tenancy policy per table',
              'a restrictive policy needs a permissive one to restrict',
            ]),
          );
        },
      );
    });

    it('catches a nullable business_id', async () => {
      await whenSchemaIs(
        db.admin,
        'alter table public.businesses alter column business_id drop not null',
        (findings) => {
          expect(rules(findings)).toContain('business_id uuid not null on every application table');
        },
      );
    });

    it('catches row security that is enabled but not forced', async () => {
      await whenSchemaIs(
        db.admin,
        'alter table public.businesses no force row level security',
        (findings) => {
          expect(rules(findings)).toContain(
            'row security enabled and forced on every application table',
          );
        },
      );
    });

    it('catches a second restrictive policy', async () => {
      await whenSchemaIs(
        db.admin,
        `create policy extra_businesses on public.businesses as restrictive for all using (true)`,
        (findings) => {
          expect(rules(findings)).toContain('exactly one restrictive tenancy policy per table');
        },
      );
    });

    it('catches a tenancy policy that reads something other than the session setting', async () => {
      await whenSchemaIs(
        db.admin,
        `drop policy tenancy_businesses on public.businesses;
         create policy tenancy_businesses on public.businesses as restrictive for all
           using (business_id = current_setting('request.jwt.claim.business')::uuid)`,
        (findings) => {
          expect(rules(findings)).toContain(
            'the tenancy policy reads the session setting and nothing else',
          );
        },
      );
    });

    // The predicate is exactly right in both halves and there is exactly one
    // restrictive policy, so the command rule is the only one left to fire.
    // Without it, SELECT and DELETE fall to the permissive baseline alone and
    // every business's rows read across the boundary.
    it('catches a tenancy policy scoped to one command', async () => {
      await whenSchemaIs(
        db.admin,
        `drop policy tenancy_businesses on public.businesses;
         create policy tenancy_businesses on public.businesses as restrictive for update
           using (business_id = (select public.app_business_id()))
           with check (business_id = (select public.app_business_id()))`,
        (findings) => {
          expect(rules(findings)).toContain('the tenancy policy covers every command');
          expect(rules(findings)).not.toContain(
            'the tenancy policy reads the session setting and nothing else',
          );
          expect(rules(findings)).not.toContain('exactly one restrictive tenancy policy per table');
        },
      );
    });

    it('catches a join in a policy', async () => {
      await whenSchemaIs(
        db.admin,
        `create policy joined_businesses on public.businesses as permissive for all
           using (exists (select 1 from public.businesses other where other.id = businesses.id))`,
        (findings) => {
          expect(rules(findings)).toContain('policies carry no joins');
        },
      );
    });
  });

  describe('the composite-key linter', () => {
    it('finds nothing to say about the migrated schema', async () => {
      expect(await lintCompositeKeys(db.admin.execute)).toStrictEqual([]);
    });

    it('refuses a single-column cross-table foreign key', async () => {
      await whenSchemaIs(
        db.admin,
        `create table public.child (
           business_id uuid not null, id uuid primary key,
           parent_id uuid not null references public.businesses (id))`,
        (findings) => {
          expect(rules(findings)).toContain('no single-column cross-table foreign key');
        },
      );
    });

    it('refuses a composite key that does not lead with business_id', async () => {
      await whenSchemaIs(
        db.admin,
        `create table public.child (
           business_id uuid not null, id uuid not null, key text not null,
           foreign key (key, business_id) references public.businesses (key, business_id))`,
        (findings) => {
          expect(rules(findings)).toContain(
            'a composite foreign key leads with business_id on both sides',
          );
        },
      );
    });

    it('accepts the composite key the law asks for', async () => {
      await whenSchemaIs(
        db.admin,
        `create table public.child (
           business_id uuid not null, id uuid not null, parent_id uuid not null,
           primary key (id), unique (business_id, id),
           foreign key (business_id, parent_id) references public.businesses (business_id, id))`,
        (findings) => {
          expect(rules(findings)).not.toContain('no single-column cross-table foreign key');
          expect(rules(findings)).not.toContain(
            'a composite foreign key leads with business_id on both sides',
          );
        },
      );
    });
  });
});
