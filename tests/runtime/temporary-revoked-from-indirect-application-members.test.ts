// SPDX-License-Identifier: AGPL-3.0-only
//
// 0031 revokes TEMPORARY from PUBLIC, the application group and each of its
// direct members, so a login that holds the group through a middle role kept
// its own grant, and the middle role kept one it passes down. A temporary
// table on a pooled backend can shadow `records` for the next tenant
// (DATA.md), so after an upgrade neither may hold it. The database is built
// at 0028, before 0031, with both grants in place, then migrated to the head.

import { afterEach, describe, expect, it } from 'vitest';
import {
  APPLICATION_ROLE,
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'TEMPORARY after an upgrade, held through a middle role',
  () => {
    let db: EmptyDatabase | undefined;
    let roles: readonly string[] = [];

    afterEach(async () => {
      const on = db;
      db = undefined;
      if (on === undefined) return;
      await on.drop();
      // The roles are the cluster's, so they outlive the database and are dropped from outside it.
      const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
      for (const role of roles) {
        // oxlint-disable-next-line no-await-in-loop -- the login before the role it is a member of
        await server.execute(`drop role if exists "${role}"`);
      }
      await server.close();
    });

    it('refuses TEMPORARY to a login that holds the application group through a middle role', async () => {
      db = await createEmptyDatabase({ part: 'indirecttemp' });
      await applyMigrations(
        db.admin,
        readMigrations('migrations').filter((m) => m.version.slice(0, 4) <= '0028'),
      );
      const middle = `${db.name}_middle`;
      const login = `${db.name}_indirect`;
      roles = [login, middle];
      await db.admin.execute(`create role "${middle}" nologin in role ${APPLICATION_ROLE}`);
      await db.admin.execute(`create role "${login}" login in role "${middle}"`);
      await db.admin.execute(`grant temporary on database "${db.name}" to "${middle}", "${login}"`);

      await db.closeSessions();
      await migrate(db.admin, 'migrations');

      const [held] = await db.admin.execute<{ readonly login: boolean; readonly middle: boolean }>(
        `select has_database_privilege($1, current_database(), 'TEMPORARY') as login,
              has_database_privilege($2, current_database(), 'TEMPORARY') as middle`,
        [login, middle],
      );
      expect(held).toStrictEqual({ login: false, middle: false });
    }, 120_000);
  },
);
