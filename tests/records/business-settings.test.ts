// SPDX-License-Identifier: AGPL-3.0-only
//
// The business settings the accepted model names, installed with their write
// modes classified.
//
// Four landed contracts read a setting that had no table: the four-eyes band
// (default five hundred, "off" permitted), the retention window, the
// conversation window and the client sign-off requirement. This is the
// producer for those rows, and the assertion that matters is the one D01
// makes about fields: no setting carries an unclassified write mode, because a
// setting that changes who may approve money is not a value a generic editor
// reaches.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUSINESS_SETTINGS,
  installBusinessSettings,
  isSettingRevisionStale,
  readBusinessSetting,
  readBusinessSettings,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import {
  createEmptyDatabase,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';

/** A promise a test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wait, bounded, until a backend in this database is parked on a lock.
 *
 * The same synchronisation point `tests/commands/lost-update.test.ts` uses for
 * `lockTask`: until a backend appears in `pg_stat_activity` blocked on a lock
 * there is no evidence the second transaction ever reached the contested read,
 * and without it the assertions below are about a sequence and not a race. The
 * owner connection asks, because both application connections are inside
 * transactions of their own. Recursion rather than a loop, because the
 * repository's lint forbids awaiting in one.
 */
async function awaitBlockedOnLock(
  db: FreshDatabase,
  deadline: number,
): Promise<{ readonly statement: string }> {
  const rows = await db.admin.execute<{ readonly query: string }>(
    `select query
       from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event_type = 'Lock'
      limit 1`,
  );
  const found = rows[0];
  if (found !== undefined) return { statement: found.query };
  if (Date.now() > deadline) {
    throw new Error(
      'the second transaction never blocked on a lock: the contested read was not reached, ' +
        'so this run establishes no interleaving and proves nothing about two writers',
    );
  }
  await delay(25);
  return awaitBlockedOnLock(db, deadline);
}

/** How long the interleaving is given to appear. Generous, and finite. */
const WITHIN = 10_000;

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('business settings', () => {
  let db: FreshDatabase;
  let business: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2s' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      await installBusinessSettings(tx);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('produces every setting the accepted model names', async () => {
    const rows = await db.app.withBusiness(business, readBusinessSettings);
    expect(rows.map((row) => row.key).toSorted()).toStrictEqual([
      'client_sign_off_required',
      'conversation_window_days',
      'four_eyes_threshold',
      'retention_window_days',
    ]);
  });

  it('classifies the write mode of every one of them, with no default', async () => {
    const rows = await db.app.withBusiness(business, readBusinessSettings);
    for (const row of rows) {
      expect(['generic', 'operation', 'system']).toContain(row.writeMode);
    }
    // The band that decides whether a second approver is needed is owned by
    // the operation that changes it, not editable as ordinary configuration.
    const band = rows.find((row) => row.key === 'four_eyes_threshold');
    expect(band?.writeMode).toBe('operation');
    expect(band?.owningOperations).toStrictEqual(['settings.set_four_eyes_threshold']);
  });

  it('defaults the four-eyes band to five hundred and permits it being off', async () => {
    const band = await db.app.withBusiness(business, async (tx) =>
      readBusinessSetting(tx, 'four_eyes_threshold'),
    );
    expect(band?.value).toBe(500);
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(
        `update business_settings set value = 'null'::jsonb
          where business_id = $1 and key = 'four_eyes_threshold'`,
        [business],
      );
    });
    const off = await db.app.withBusiness(business, async (tx) =>
      readBusinessSetting(tx, 'four_eyes_threshold'),
    );
    expect(off?.value).toBeNull();
  });

  it('refuses a value that is not of the type the row says it is', async () => {
    await expect(
      db.app.withBusiness(business, async (tx) => {
        await tx.query(
          `update business_settings set value = '"five hundred"'::jsonb
            where business_id = $1 and key = 'four_eyes_threshold'`,
          [business],
        );
      }),
    ).rejects.toThrow(/business_settings_value_matches_type/iu);
  });

  it('is idempotent: installing twice leaves one row per setting', async () => {
    await db.app.withBusiness(business, async (tx) => {
      await installBusinessSettings(tx);
    });
    const rows = await db.app.withBusiness(business, readBusinessSettings);
    expect(rows.length).toBe(BUSINESS_SETTINGS.length);
  });

  describe('the revision', () => {
    it('starts at 1 on every setting a fresh install produces', async () => {
      const rows = await db.app.withBusiness(business, readBusinessSettings);
      expect(rows.map((row) => [row.key, row.revision])).toStrictEqual([
        ['client_sign_off_required', 1],
        ['conversation_window_days', 1],
        ['four_eyes_threshold', 1],
        ['retention_window_days', 1],
      ]);
    });

    it('counts up once per write, and the read hands back the new one', async () => {
      const first = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, { key: 'conversation_window_days', value: 45 }),
      );
      expect(isSettingRevisionStale(first ?? {})).toBe(false);
      expect(first).toMatchObject({ key: 'conversation_window_days', value: 45, revision: 2 });

      const second = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, { key: 'conversation_window_days', value: 60 }),
      );
      expect(second).toMatchObject({ value: 60, revision: 3 });

      const read = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'conversation_window_days'),
      );
      expect(read).toMatchObject({ value: 60, revision: 3 });
    });

    it('proceeds when no revision is named, which is what the landed caller does', async () => {
      const before = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'conversation_window_days'),
      );
      const written = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, { key: 'conversation_window_days', value: 61 }),
      );
      expect(written).toMatchObject({ value: 61, revision: (before?.revision ?? 0) + 1 });
    });

    it('refuses a write against a revision that has moved on, and changes nothing', async () => {
      const before = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'conversation_window_days'),
      );
      const stale = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, {
          key: 'conversation_window_days',
          value: 999,
          expectedRevision: (before?.revision ?? 0) - 1,
        }),
      );
      expect(isSettingRevisionStale(stale ?? {})).toBe(true);
      expect(stale).toStrictEqual({
        refused: true,
        code: 'VERSION_STALE',
        names: [`revision=${before?.revision}`],
        fixes: [
          'Read the setting and send the revision you are writing against as expected_revision.',
          'A write against a stale revision is refused, never merged.',
        ],
      });
      const after = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'conversation_window_days'),
      );
      expect(after).toMatchObject({ value: before?.value, revision: before?.revision });
    });

    it('applies the write of the revision it names, at the revision it names', async () => {
      const before = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'conversation_window_days'),
      );
      const written = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, {
          key: 'conversation_window_days',
          value: 15,
          expectedRevision: before?.revision ?? 0,
        }),
      );
      expect(written).toMatchObject({ value: 15, revision: (before?.revision ?? 0) + 1 });
    });

    it('answers nothing at all for a key this business has no row for', async () => {
      const absent = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, { key: 'no_such_setting', value: 1 }),
      );
      expect(absent).toBeUndefined();
    });

    it('writes an operation-owned row only for an operation the row names', async () => {
      const band = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, {
          key: 'four_eyes_threshold',
          value: 1200,
          owningOperation: 'settings.set_four_eyes_threshold',
        }),
      );
      expect(band).toMatchObject({ value: 1200 });
      const notItsOperation = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, {
          key: 'four_eyes_threshold',
          value: 1300,
          owningOperation: 'settings.set_client_sign_off',
        }),
      );
      expect(notItsOperation).toBeUndefined();
      const kept = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'four_eyes_threshold'),
      );
      expect(kept?.value).toBe(1200);
    });

    it('does not move on a second install', async () => {
      const before = await db.app.withBusiness(business, readBusinessSettings);
      await db.app.withBusiness(business, installBusinessSettings);
      const after = await db.app.withBusiness(business, readBusinessSettings);
      expect(after.map((row) => [row.key, row.revision])).toStrictEqual(
        before.map((row) => [row.key, row.revision]),
      );
    });
  });

  describe('two administrators writing at once', () => {
    let second: Database;

    beforeAll(() => {
      // A second connection, because the first is `max: 1` and two
      // transactions on it would queue in the pool rather than race in the
      // server.
      second = connect(db.appUrl, { source: 'runtime' });
    });

    afterAll(async () => {
      await second?.close();
    });

    it("applies one and tells the other it is stale, with the winner's value standing", async () => {
      const shared = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'retention_window_days'),
      );
      const revision = shared?.revision ?? 0;
      expect(revision).toBeGreaterThan(0);

      const commit = barrier();
      const wrote = barrier();

      // The first administrator: write, say so, and hold the transaction open
      // until the second is known to be waiting on the row.
      const first = db.app.withBusiness(business, async (tx) => {
        const outcome = await writeBusinessSetting(tx, {
          key: 'retention_window_days',
          value: 111,
          expectedRevision: revision,
        });
        wrote.release();
        await commit.held;
        return outcome;
      });

      await wrote.held;

      // The second administrator, on their own connection, presenting the
      // revision they read before the first started -- which is exactly what a
      // second browser tab holds.
      const other = second.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, {
          key: 'retention_window_days',
          value: 222,
          expectedRevision: revision,
        }),
      );

      const waiter = await awaitBlockedOnLock(db, Date.now() + WITHIN).finally(() => {
        // Released whatever happened, so a failed run ends rather than hanging
        // the rest of the file behind a transaction nobody will commit.
        commit.release();
      });
      // Blocking at the contested read is the mechanism; blocking at the write
      // would mean the comparison had already run against the stale row.
      expect(waiter.statement).toContain('for update');

      const [winner, loser] = await Promise.all([first, other]);

      expect(winner).toMatchObject({ value: 111, revision: revision + 1 });
      expect(isSettingRevisionStale(loser ?? {})).toBe(true);
      expect(loser).toMatchObject({ code: 'VERSION_STALE', names: [`revision=${revision + 1}`] });

      // Exactly one write landed, and the value standing is the winner's.
      const standing = await db.app.withBusiness(business, async (tx) =>
        readBusinessSetting(tx, 'retention_window_days'),
      );
      expect(standing).toMatchObject({ value: 111, revision: revision + 1 });
    }, 30_000);
  });

  it('keeps a changed value across a second install, rather than resetting it', async () => {
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(
        `update business_settings set value = to_jsonb(90::numeric)
          where business_id = $1 and key = 'retention_window_days'`,
        [business],
      );
      await installBusinessSettings(tx);
    });
    const kept = await db.app.withBusiness(business, async (tx) =>
      readBusinessSetting(tx, 'retention_window_days'),
    );
    expect(kept?.value).toBe(90);
  });
});

/**
 * The revision on a business that already had its settings before 0020 ran.
 *
 * The column's default is what answers this, and a default is the one part of
 * an `alter table` that an installation with rows in it exercises and an
 * install from empty never does. So the settings are installed against the
 * schema as it stood before the migration, and the migration is applied under
 * them.
 */
describe.skipIf(serverUrl === undefined)(
  'business settings, upgraded rather than installed',
  () => {
    let db: EmptyDatabase;
    let business: string;

    beforeAll(async () => {
      const onDisk = readMigrations('migrations');
      // Found by name, not taken as the last: later migrations follow it.
      const revision = onDisk.findIndex(
        (migration) => migration.version === '0020_business_settings_revision',
      );
      expect(revision).toBeGreaterThan(0);
      db = await createEmptyDatabase({ part: 'l2sup' });
      await applyMigrations(db.admin, onDisk.slice(0, revision));
      business = await insertBusiness(db.app, 'before');
      await db.app.withBusiness(business, installBusinessSettings);
      // The runner refuses while this database has other sessions; seeding opened one.
      await db.closeSessions();
      await applyMigrations(db.admin, onDisk);
    }, 180_000);

    afterAll(async () => {
      await db?.drop();
    });

    it('gives every row that was already there a revision of 1', async () => {
      const rows = await db.app.withBusiness(business, readBusinessSettings);
      expect(rows.length).toBe(BUSINESS_SETTINGS.length);
      expect(rows.every((row) => row.revision === 1)).toBe(true);
    });

    it('counts up from 1 for a business that was upgraded', async () => {
      const written = await db.app.withBusiness(business, async (tx) =>
        writeBusinessSetting(tx, { key: 'retention_window_days', value: 7, expectedRevision: 1 }),
      );
      expect(written).toMatchObject({ value: 7, revision: 2 });
    });
  },
);
