// SPDX-License-Identifier: AGPL-3.0-only
//
// FR2-P3, migration 0031: two things an upgrade from 0028 carried forward
// unchecked (Sol round 3, SOL-R3-1 and SOL-R3-2).
//
//   1. SOL-R3-2: PostgreSQL grants TEMPORARY on a new database to PUBLIC.
//      db-up.sh and the test harness revoke it where the database is made
//      (R2-AUTHORITY-61), but no migration did, so a database made before that
//      revoke and brought forward with `db:migrate` alone still let the
//      application login create a temporary table that can shadow `records`
//      for the next tenant on a pooled backend.
//   2. SOL-R3-1: 0029 closed the hole through which an application writer
//      could commit a cap past its ceiling, by clearing or switching
//      `app.business_id` before commit, but it checked no row already written
//      through that hole, so an over-ceiling total survived the upgrade.
//
// Each upgrade fixture is built at 0028 through the application role, then
// brought forward with the migrations alone. A fresh database migrates as
// before. 0031 changes no row: an over-ceiling database refuses the upgrade
// with its rows as they were, and the ledger does not record 0031.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  APPLICATION_ROLE,
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/final-r2-dbtest-upgrade-guards: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const THROUGH_0028 = (version: string): boolean => version.slice(0, 4) <= '0028';
const LIMIT = 1000;

const onDisk = readMigrations('migrations');

async function at0028(part: string): Promise<EmptyDatabase> {
  const db = await createEmptyDatabase({ part });
  await applyMigrations(
    db.admin,
    onDisk.filter((m) => THROUGH_0028(m.version)),
  );
  return db;
}

async function lastApplied(db: EmptyDatabase): Promise<string> {
  const [ledger] = await db.admin.execute<{ readonly last: string }>(
    'select max(version) as last from ops.schema_migrations',
  );
  return ledger?.last.slice(0, 4) ?? '';
}

/** Whether the application login holds TEMPORARY, asked as that login. */
async function appHoldsTemporary(db: EmptyDatabase, business: string): Promise<boolean> {
  return await db.app.withBusiness(business, async (tx) => {
    const [row] = await tx.query<{ readonly held: boolean }>(
      `select has_database_privilege(current_user, current_database(), 'TEMPORARY') as held`,
    );
    return row?.held ?? false;
  });
}

describe.skipIf(serverUrl === undefined)('SOL-R3-2: TEMPORARY after an upgrade from 0028', () => {
  let db: EmptyDatabase | undefined;

  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  // The fixture's database is made with TEMPORARY revoked from PUBLIC, as
  // every database is now; granting it back is the database an 0028 install
  // made before that revoke still has.
  it.each([
    ['PUBLIC, the PostgreSQL default', (_db: EmptyDatabase): string => 'public'],
    ['the application group', (_db: EmptyDatabase): string => APPLICATION_ROLE],
    ['the application login', (d: EmptyDatabase): string => `"${d.loginRole}"`],
  ] as const)(
    'refuses the application login a temporary table once migrated, when %s held it at 0028',
    async (_label, grantee) => {
      db = await at0028('guardtemp');
      const business = await insertBusiness(db.app, 'guard-temp');
      await db.admin.execute(`grant temporary on database "${db.name}" to ${grantee(db)}`);
      expect(await appHoldsTemporary(db, business)).toBe(true);

      // The runner refuses while this database has other sessions; seeding opened one.
      await db.closeSessions();
      await migrate(db.admin, 'migrations');

      expect(await appHoldsTemporary(db, business)).toBe(false);
      await expect(
        db.app.withBusiness(business, (tx) =>
          tx.query(
            'create temp table records (business_id uuid, id uuid, data jsonb, deleted_at timestamptz)',
          ),
        ),
      ).rejects.toThrow(/permission denied/iu);
    },
    120_000,
  );

  it('migrates a fresh database with TEMPORARY refused, as before', async () => {
    db = await createEmptyDatabase({ part: 'guardtempfresh' });
    const migration = await applyMigrations(db.admin, onDisk);
    expect(migration.applied).toHaveLength(onDisk.length);
    expect(await appHoldsTemporary(db, await insertBusiness(db.app, 'guard-fresh'))).toBe(false);
  }, 120_000);
});

interface World {
  readonly db: EmptyDatabase;
  readonly business: BusinessId;
  readonly decider: Member;
  readonly capId: string;
}

/** A business with a decider who may read and write, and an AUD cap of 1000. */
async function openWorld(db: EmptyDatabase, key: string): Promise<World> {
  const business = (await insertBusiness(db.app, key)) as BusinessId;
  await installSpine(db.app, business);
  const decider = await enrol(db.app, business, 'decider');
  const capId = randomUUID();
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // Sequential: `issueGrant` reads the granter's own rows.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, decider, action);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, $3, $4, 'AUD')`,
      [business, capId, `cap-${capId}`, LIMIT],
    );
  });
  return { db, business, decider, capId };
}

/** An envelope holding `held` under the world's cap, committed as the application role. */
async function envelope(w: World, held: number): Promise<string> {
  const outcome = await executeCommand(w.db.app, w.business, w.decider.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: `guard ${randomUUID()}` },
  } as never);
  if (isCommandRefusal(outcome) || outcome.recordId === null) {
    throw new Error('task.create did not apply');
  }
  const id = randomUUID();
  await w.db.app.withBusiness(w.business, async (tx) => {
    await tx.query(
      `insert into public.task_envelopes
         (business_id, id, cap_id, task_id, maximum_minor, held_minor, currency)
       values ($1, $2, $3, $4, $5, $6, 'AUD')`,
      [w.business, id, w.capId, outcome.recordId, LIMIT * 4, held],
    );
  });
  return id;
}

/** The cap's limit and committed total, read by the owner. */
async function capState(w: World): Promise<string> {
  const [row] = await w.db.admin.execute<{ readonly state: string }>(
    `select c.limit_minor::text || ' ' ||
            coalesce((select sum(e.held_minor + e.actual_minor) from public.task_envelopes e
                       where e.business_id = c.business_id and e.cap_id = c.id), 0)::text as state
       from public.budget_caps c where c.business_id = $1 and c.id = $2`,
    [w.business, w.capId],
  );
  return row?.state ?? 'absent';
}

/** Every cap and envelope, as the owner reads them, in one string. */
async function capSnapshot(db: EmptyDatabase): Promise<string> {
  const [row] = await db.admin.execute<{ readonly all: string | null }>(
    `select coalesce((select string_agg(c::text, '|' order by c.id) from public.budget_caps c), '') || '#' ||
            coalesce((select string_agg(e::text, '|' order by e.id) from public.task_envelopes e), '')
       as all`,
  );
  return row?.all ?? '';
}

describe.skipIf(serverUrl === undefined)('SOL-R3-1: an over-ceiling total admitted at 0028', () => {
  let db: EmptyDatabase | undefined;

  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  it.each([
    ['cleared', (_w: World): string => ''],
    ['switched to another business', (w: World): string => w.decider.personId],
  ] as const)(
    'refuses the upgrade when the setting was %s before commit at 0028, with rows unchanged and 0031 not recorded',
    async (_label, settingOf) => {
      db = await at0028('guardcap');
      const w = await openWorld(db, 'guard-cap');
      const held = await envelope(w, 900);
      // The 0025 hole, as the application role: the raise passes the ceiling,
      // the setting changes, and the deferred check cannot see the cap.
      await w.db.app.withBusiness(w.business, async (tx) => {
        await tx.query(
          'update public.task_envelopes set held_minor = 1900 where business_id = $1 and id = $2',
          [w.business, held],
        );
        await tx.query(`select set_config('app.business_id', $1, true)`, [settingOf(w)]);
      });
      expect(await capState(w)).toBe('1000 1900');
      const seeded = await capSnapshot(db);

      // The runner refuses while this database has other sessions; seeding opened one.
      await db.closeSessions();
      await expect(migrate(db.admin, 'migrations')).rejects.toSatisfy((error: unknown) =>
        /budget_caps: cap .* in business .* is committed to 1900 past its ceiling 1000/u.test(
          String((error as { cause?: unknown }).cause ?? error),
        ),
      );
      expect(await lastApplied(db)).toBe('0030');
      expect(await capSnapshot(db)).toBe(seeded);
    },
    120_000,
  );

  it('upgrades a valid 0028 database, a cap filled to exactly its ceiling, with rows unchanged', async () => {
    db = await at0028('guardcapok');
    const w = await openWorld(db, 'guard-cap-ok');
    await envelope(w, 400);
    await envelope(w, 600);
    const seeded = await capSnapshot(db);
    // The runner refuses while this database has other sessions; seeding opened one.
    await db.closeSessions();
    const migration = await migrate(db.admin, 'migrations');
    expect(migration.applied.map((v) => v.slice(0, 4))).toContain('0031');
    expect(await lastApplied(db)).toBe(
      onDisk
        .map((m) => m.version.slice(0, 4))
        .toSorted()
        .at(-1),
    );
    expect(await capState(w)).toBe('1000 1000');
    expect(await capSnapshot(db)).toBe(seeded);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)('0031 on a fresh database', () => {
  let db: EmptyDatabase;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'guardfresh' });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('applies every migration once, 0031 among them', async () => {
    const migration = await applyMigrations(db.admin, onDisk);
    expect(migration.applied).toStrictEqual(onDisk.map((m) => m.version));
    expect(migration.applied.map((v) => v.slice(0, 4))).toContain('0031');
  }, 120_000);
});
