// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1: the three storage backstops Nathan approved on 24 Sep
// 2026 (OWNER-SCHEMA-PROPOSALS-FR1), migrations 0026 to 0028.
//
//   1. #63 R1-RUNTIME-63, 0026: a reservation is never `actual` in the first
//      head, and an `actual` amount is never zero or negative. The handback
//      refuses any actual first (`ACTUAL_EXPENDITURE_UNSUPPORTED`,
//      `core-runtime/src/handback.ts`); storage refuses second.
//   2. #24 R1-AUTHORITY-24, 0027: a business key names one business. The
//      resolver refuses an ambiguous key first (`apps/api/server.ts`); storage
//      refuses the second business second.
//   3. #55 R1-AUTHORITY-55, 0028: the application role may not delete a
//      person_logins or person_merges row. 0002 says those rows are kept as
//      history, and no code deletes them.
//
// Every write below is the application role's, inside `withBusiness`, never
// the owner's. The same cases run on a database migrated from empty and on
// one migrated to 0025, seeded, and then upgraded: fresh and upgraded behave
// the same. The seeded rows survive the upgrade byte for byte, and a 0025
// database already holding a row a new rule forbids stops before the
// migration that states the rule, rather than keeping the row silently.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
  type MigrationOutcome,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMerge,
  insertPerson,
} from '../identity/fixture.ts';
import {
  buildFixture,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/final-r1-fr1-migrations: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const THROUGH_0025 = (version: string): boolean => version.slice(0, 4) <= '0025';
/** The three this suite is about. Later migrations may follow them on disk. */
const NEW = ['0026', '0027', '0028'];

const FIRST_HEAD_NO_ACTUAL = {
  code: '23514',
  constraint_name: 'reservations_first_head_no_actual',
};
const ACTUAL_POSITIVE = { code: '23514', constraint_name: 'reservations_actual_positive' };
const KEY_GLOBAL = { code: '23505', constraint_name: 'businesses_key_global_idx' };
const NO_DELETE = { code: '42501' };

const onDisk = readMigrations('migrations');

/** A held reservation on a new task, through propose and decide. */
async function heldReservation(
  database: Database,
  fixture: RuntimeFixture,
): Promise<{ readonly reservationId: string }> {
  const taskId = await newTask(database, fixture.businessId, fixture.decider);
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const proposed = await propose(tx, {
      taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor: 5_000,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!proposed.ok) throw new Error(`propose refused ${proposed.refusal.code}`);
    const decided = await decide(tx, {
      gateId: proposed.value.gateId,
      versionId: proposed.value.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    });
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
    if (decided.value.decision !== 'approve') throw new Error('expected an approval');
    return { reservationId: decided.value.reservationId };
  });
}

/** Identity history in the fixture's business: one login mapping and one merge. */
async function identityHistory(
  database: Database,
  fixture: RuntimeFixture,
): Promise<{ readonly mappingId: string; readonly mergeId: string }> {
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const survivor = await insertPerson(tx, `survivor ${randomUUID()}`);
    const absorbed = await insertPerson(tx, `absorbed ${randomUUID()}`);
    const actor = await insertActor(tx, survivor);
    const login = await insertLogin(tx, `history-${randomUUID()}`);
    const mappingId = await insertMapping(tx, login, survivor, actor);
    const mergeId = await insertMerge(tx, survivor, absorbed, actor);
    return { mappingId, mergeId };
  });
}

/** As the application role: one statement in the fixture's tenant transaction. */
async function asApp(
  database: Database,
  fixture: RuntimeFixture,
  text: string,
  parameters: readonly unknown[],
): Promise<number> {
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const rows = await tx.query(text, [...parameters]);
    return rows.length;
  });
}

/** A reservation's state and amounts, read by the owner as text. */
async function reservationState(db: EmptyDatabase, reservationId: string): Promise<string> {
  const [row] = await db.admin.execute<{ readonly state: string }>(
    `select state || ' ' || held_minor::text || ' ' || coalesce(actual_minor::text, 'null') as state
       from public.reservations where id = $1`,
    [reservationId],
  );
  return row?.state ?? 'absent';
}

async function rowCount(db: EmptyDatabase, table: string, id: string): Promise<number> {
  const rows = await db.admin.execute(`select 1 from public.${table} where id = $1`, [id]);
  return rows.length;
}

/** Every row the three rules touch, as the owner reads it, in one string. */
async function seedSnapshot(db: EmptyDatabase): Promise<string> {
  const [row] = await db.admin.execute<{ readonly all: string | null }>(
    `select coalesce((select string_agg(b::text, '|' order by b.id) from public.businesses b), '') || '#' ||
            coalesce((select string_agg(r::text, '|' order by r.id) from public.reservations r), '') || '#' ||
            coalesce((select string_agg(p::text, '|' order by p.id) from public.person_logins p), '') || '#' ||
            coalesce((select string_agg(m::text, '|' order by m.id) from public.person_merges m), '')
       as all`,
  );
  return row?.all ?? '';
}

interface Built {
  readonly db: EmptyDatabase;
  readonly migration: MigrationOutcome;
  readonly seeded?: string;
  readonly seededAfter?: string;
}

async function fresh(): Promise<Built> {
  const db = await createEmptyDatabase({ part: 'fr1mfresh' });
  return { db, migration: await applyMigrations(db.admin, onDisk) };
}

async function upgraded(): Promise<Built> {
  const db = await createEmptyDatabase({ part: 'fr1mupgraded' });
  await applyMigrations(
    db.admin,
    onDisk.filter((m) => THROUGH_0025(m.version)),
  );
  // Valid rows written through the application role at 0025: two businesses
  // under their own keys, a held reservation, and identity history.
  const seed = await buildFixture(db.app, 'seed-0025-a');
  await buildFixture(db.app, 'seed-0025-b');
  await heldReservation(db.app, seed);
  await identityHistory(db.app, seed);
  const seeded = await seedSnapshot(db);
  // The runner refuses while this database has other sessions; seeding opened one.
  await db.closeSessions();
  const migration = await migrate(db.admin, 'migrations');
  return { db, migration, seeded, seededAfter: await seedSnapshot(db) };
}

describe.skipIf(serverUrl === undefined).each([
  ['fresh', fresh],
  ['upgraded from 0025', upgraded],
] as const)('FR1 storage backstops on a %s database', (label, build) => {
  let built: Built;
  let fixture: RuntimeFixture;

  beforeAll(async () => {
    built = await build();
    fixture = await buildFixture(built.db.app, `fr1m-${label.replaceAll(' ', '-')}`);
  }, 120_000);

  afterAll(async () => {
    await built?.db.drop();
  });

  it('applies 0026, 0027 and 0028 after 0025, and every migration once', () => {
    const through = onDisk.filter((m) => THROUGH_0025(m.version)).map((m) => m.version);
    const after = onDisk.filter((m) => !THROUGH_0025(m.version)).map((m) => m.version);
    expect(after.slice(0, 3).map((v) => v.slice(0, 4))).toStrictEqual(NEW);
    const expected =
      label === 'fresh'
        ? { applied: [...through, ...after], alreadyApplied: [] }
        : { applied: after, alreadyApplied: through };
    expect({
      applied: built.migration.applied,
      alreadyApplied: built.migration.alreadyApplied,
    }).toStrictEqual(expected);
  });

  // Only the upgraded leg has seeded rows, so only it registers the case.
  if (label !== 'fresh') {
    it('keeps every seeded row as it was', () => {
      const [businesses, reservations, mappings, merges] = (built.seeded ?? '').split('#');
      expect(businesses).toMatch(/seed-0025-a/u);
      expect(businesses).toMatch(/seed-0025-b/u);
      expect(reservations).toMatch(/,held,5000,/u);
      expect(mappings).not.toBe('');
      expect(merges).toMatch(/a person decided/u);
      expect(built.seededAfter).toBe(built.seeded);
    });
  }

  describe('#63: a reservation is never actual in the first head', () => {
    const settle = (actual: number) => async (reservationId: string) =>
      await asApp(
        built.db.app,
        fixture,
        `update public.reservations set state = 'actual', actual_minor = $3, terminal_at = now()
          where business_id = $1 and id = $2 returning id`,
        [fixture.businessId, reservationId, actual],
      );

    // Postgres checks a row's constraints in name order, so a zero or negative
    // actual, which breaks both rules, is reported by `reservations_actual_positive`.
    it.each([
      ['a zero actual', 0, ACTUAL_POSITIVE],
      ['a negative actual', -5, ACTUAL_POSITIVE],
      ['a positive actual', 500, FIRST_HEAD_NO_ACTUAL],
    ] as const)('refuses settling a held reservation on %s', async (_label, actual, refusal) => {
      const { reservationId } = await heldReservation(built.db.app, fixture);
      const before = await reservationState(built.db, reservationId);
      expect(before).toBe('held 5000 null');
      await expect(settle(actual)(reservationId)).rejects.toMatchObject(refusal);
      expect(await reservationState(built.db, reservationId)).toBe(before);
    });

    it('still lets a held reservation be quarantined (control)', async () => {
      const { reservationId } = await heldReservation(built.db.app, fixture);
      await asApp(
        built.db.app,
        fixture,
        `update public.reservations set state = 'quarantined' where business_id = $1 and id = $2`,
        [fixture.businessId, reservationId],
      );
      expect(await reservationState(built.db, reservationId)).toBe('quarantined 5000 null');
    });

    // The positive-amount check is for the head that lifts the first rule. It
    // is proved here with that rule dropped, in this throwaway database only.
    it('refuses a zero or negative actual once actual is allowed, and keeps a positive one', async () => {
      const db = await createEmptyDatabase({ part: 'fr1mactual' });
      try {
        await applyMigrations(db.admin, onDisk);
        await db.admin.execute(
          'alter table public.reservations drop constraint reservations_first_head_no_actual',
        );
        const own = await buildFixture(db.app, 'fr1m-actual');
        for (const actual of [0, -5]) {
          // eslint-disable-next-line no-await-in-loop
          const { reservationId } = await heldReservation(db.app, own);
          // eslint-disable-next-line no-await-in-loop
          await expect(
            asApp(
              db.app,
              own,
              `update public.reservations set state = 'actual', actual_minor = $3, terminal_at = now()
                where business_id = $1 and id = $2`,
              [own.businessId, reservationId, actual],
            ),
          ).rejects.toMatchObject(ACTUAL_POSITIVE);
          // eslint-disable-next-line no-await-in-loop
          expect(await reservationState(db, reservationId)).toBe('held 5000 null');
        }
        const { reservationId } = await heldReservation(db.app, own);
        await asApp(
          db.app,
          own,
          `update public.reservations set state = 'actual', actual_minor = 500, terminal_at = now()
            where business_id = $1 and id = $2`,
          [own.businessId, reservationId],
        );
        expect(await reservationState(db, reservationId)).toBe('actual 5000 500');
      } finally {
        await db.drop();
      }
    }, 120_000);
  });

  describe('#24: a business key names one business', () => {
    it('refuses a second business under a key another holds', async () => {
      const key = `fr1m-${label.replaceAll(' ', '-')}`;
      await expect(insertBusiness(built.db.app, key)).rejects.toMatchObject(KEY_GLOBAL);
      const holders = await built.db.admin.execute<{ readonly id: string }>(
        'select id from public.businesses where key = $1',
        [key],
      );
      expect(holders.map((row) => row.id)).toStrictEqual([fixture.businessId]);
    });

    it('refuses renaming a business to a key another holds', async () => {
      const other = await buildFixture(built.db.app, `fr1m-other-${randomUUID()}`);
      await expect(
        asApp(built.db.app, other, 'update public.businesses set key = $2 where id = $1', [
          other.businessId,
          `fr1m-${label.replaceAll(' ', '-')}`,
        ]),
      ).rejects.toMatchObject(KEY_GLOBAL);
    });

    it('still takes a business under a key nobody holds (control)', async () => {
      const key = `fr1m-unique-${randomUUID()}`;
      const id = await insertBusiness(built.db.app, key);
      const holders = await built.db.admin.execute<{ readonly id: string }>(
        'select id from public.businesses where key = $1',
        [key],
      );
      expect(holders.map((row) => row.id)).toStrictEqual([id]);
    });
  });

  describe('#55: identity history is never deleted by the application role', () => {
    it.each([
      ['person_logins', 'mappingId'],
      ['person_merges', 'mergeId'],
    ] as const)('refuses deleting a %s row', async (table, which) => {
      const history = await identityHistory(built.db.app, fixture);
      const id = history[which];
      await expect(
        asApp(
          built.db.app,
          fixture,
          `delete from public.${table} where business_id = $1 and id = $2 returning id`,
          [fixture.businessId, id],
        ),
      ).rejects.toMatchObject(NO_DELETE);
      expect(await rowCount(built.db, table, id)).toBe(1);
    });

    it('still selects, inserts and updates both (control)', async () => {
      const { mappingId, mergeId } = await identityHistory(built.db.app, fixture);
      expect(
        await asApp(
          built.db.app,
          fixture,
          `update public.person_logins set active = false, deactivated_at = now()
            where business_id = $1 and id = $2 returning id`,
          [fixture.businessId, mappingId],
        ),
      ).toBe(1);
      expect(
        await asApp(
          built.db.app,
          fixture,
          `update public.person_merges
              set reversed_at = now(), reversed_by_actor_id = decided_by_actor_id,
                  reversal_evidence = 'a person reversed it, in the suite'
            where business_id = $1 and id = $2 returning id`,
          [fixture.businessId, mergeId],
        ),
      ).toBe(1);
    });
  });
});

describe.skipIf(serverUrl === undefined)('a 0025 database holding a row a new rule forbids', () => {
  it.each([
    [
      'an actual reservation',
      async (db: EmptyDatabase) => {
        const own = await buildFixture(db.app, 'refused-actual');
        const { reservationId } = await heldReservation(db.app, own);
        // At 0025 nothing in storage stops it; only the handback did.
        await asApp(
          db.app,
          own,
          `update public.reservations set state = 'actual', actual_minor = 0, terminal_at = now()
            where business_id = $1 and id = $2`,
          [own.businessId, reservationId],
        );
      },
      /reservations_first_head_no_actual/u,
      '0025',
    ],
    [
      'two businesses under one key',
      async (db: EmptyDatabase) => {
        await buildFixture(db.app, 'refused-shared');
        await insertBusiness(db.app, 'refused-shared');
      },
      /businesses_key_global_idx/u,
      '0025',
    ],
  ] as const)(
    'refuses the upgrade for %s, stopping before the rule with the rows untouched',
    async (_label, write, message, stopsAt) => {
      const db = await createEmptyDatabase({ part: 'fr1mrefused' });
      try {
        await applyMigrations(
          db.admin,
          onDisk.filter((m) => THROUGH_0025(m.version)),
        );
        await write(db);
        const seeded = await seedSnapshot(db);
        // The runner refuses while this database has other sessions; seeding opened one.
        await db.closeSessions();
        await expect(migrate(db.admin, 'migrations')).rejects.toSatisfy((error: unknown) =>
          message.test(String((error as { cause?: unknown }).cause ?? error)),
        );
        const [ledger] = await db.admin.execute<{ readonly last: string }>(
          `select max(version) as last from ops.schema_migrations`,
        );
        expect(ledger?.last.slice(0, 4)).toBe(stopsAt);
        expect(await seedSnapshot(db)).toBe(seeded);
      } finally {
        await db.drop();
      }
    },
    120_000,
  );
});
