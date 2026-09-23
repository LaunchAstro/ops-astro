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
  readBusinessSetting,
  readBusinessSettings,
} from '../../packages/core-records/src/records/business-settings.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';

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
