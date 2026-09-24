// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, R2-AUTHORITY-61: the application may create nothing,
// not even a temporary table.
//
// PostgreSQL grants TEMPORARY on every new database to PUBLIC. A temporary
// relation lives for the session, not the transaction, so on a pooled backend
// it outlives `SET LOCAL` and the next tenant's unqualified `from records`
// resolves to it before `public.records`, with no row security on it. DATA.md
// says the server refuses runtime DDL so that no convention has to forbid it.
// So the harness revokes TEMPORARY where it makes the database, and the
// default-deny rules notice it handed back to PUBLIC or to the application.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPLICATION_ROLE,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  defaultDenyConformance,
  type StorageRoles,
} from '../../packages/core-records/src/tenancy/privileges.ts';
import { insertBusiness } from '../identity/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const RULE = 'the application role may create nothing, not even a temporary table';

describe.skipIf(serverUrl === undefined)('R2-AUTHORITY-61: TEMPORARY on the database', () => {
  let db: FreshDatabase;
  let business: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'r2fr2apitemp' });
    business = await insertBusiness(db.app, 'alpha');
  }, 60_000);

  afterAll(async () => await db?.drop());

  it('refuses the application login a temporary table', async () => {
    await expect(
      db.app.withBusiness(business, (tx) =>
        tx.query(
          'create temp table records (business_id uuid, id uuid, data jsonb, deleted_at timestamptz)',
        ),
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  class Rollback extends Error {}

  const roles = (): StorageRoles => ({
    owner: 'postgres',
    application: APPLICATION_ROLE,
    logins: [db.loginRole],
    restricted: db.restrictedRole,
  });

  const whenDatabaseIs = async (breakage: string): Promise<readonly string[]> => {
    let rules: readonly string[] = [];
    try {
      await db.admin.transaction(async (execute) => {
        await execute(breakage);
        rules = (await defaultDenyConformance(execute, roles())).map((finding) => finding.rule);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return rules;
  };

  it('finds nothing wrong on the database as the harness made it', async () => {
    expect(await defaultDenyConformance(db.admin.execute, roles())).toStrictEqual([]);
  });

  it('catches TEMPORARY granted to PUBLIC', async () => {
    expect(await whenDatabaseIs(`grant temporary on database "${db.name}" to public`)).toContain(
      RULE,
    );
  });

  it('catches TEMPORARY granted to the application group', async () => {
    expect(
      await whenDatabaseIs(`grant temporary on database "${db.name}" to ${APPLICATION_ROLE}`),
    ).toContain(RULE);
  });

  it('catches TEMPORARY granted straight to the application login', async () => {
    expect(
      await whenDatabaseIs(`grant temporary on database "${db.name}" to "${db.loginRole}"`),
    ).toContain(RULE);
  });

  it('was rolled back each time: the database is as the harness made it', async () => {
    expect(await defaultDenyConformance(db.admin.execute, roles())).toStrictEqual([]);
  });
});
