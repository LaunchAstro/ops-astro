// SPDX-License-Identifier: AGPL-3.0-only
//
// I01 R6 and the expired session: the two halves of "authority the application
// cannot grant itself".
//
// `ops_astro_worker` is default-deny at the database level, so a worker that
// reaches for a table is refused by the server rather than by application
// code. The catalogue is what is read here, not a setup script's intention: a
// privilege nobody granted and a privilege somebody revoked look the same in
// `information_schema`, and only one of them was decided.
//
// `EXPIRED_FIXES` is the other half, one layer up: what the door in
// `apps/api/app.ts` answers, as `AUTH_SESSION_EXPIRED`, when a verified token
// has expired. It is a typed refusal because a person has to be able to tell
// "sign in again" from "you may not see this" and from "the server is broken",
// and only one of those is a door they can open. The whole wire body, key set
// included, is pinned where the server sends it (`tests/api/admission-enumeration.test.ts`).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPIRED_FIXES } from '../../packages/core-records/src/identity/agent-login.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
const WORKER = 'ops_astro_worker';

describe('the expired session', () => {
  it('tells a client to sign in again, which is the re-login path', () => {
    expect(EXPIRED_FIXES.join(' ')).toMatch(/sign in again/iu);
  });

  it('says that nothing was changed, because a client may retry after signing in', () => {
    expect(EXPIRED_FIXES.join(' ')).toMatch(/nothing was changed/iu);
  });
});

describe.skipIf(serverUrl === undefined)('the restricted worker role', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2r' });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('exists, and cannot log in or bypass row security by itself', async () => {
    const [role] = await db.admin.execute<{
      readonly rolcanlogin: boolean;
      readonly rolsuper: boolean;
      readonly rolbypassrls: boolean;
      readonly rolcreaterole: boolean;
    }>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole
         from pg_roles where rolname = $1`,
      [WORKER],
    );
    expect(role).toBeDefined();
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
    expect(role?.rolcreaterole).toBe(false);
    expect(role?.rolcanlogin).toBe(false);
  });

  it('holds no privilege on any table in public or ops', async () => {
    const granted = await db.admin.execute<{ readonly relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'ops')
          and c.relkind in ('r', 'v', 'm', 'p')
          and has_table_privilege($1, c.oid, 'select, insert, update, delete, truncate')
        order by c.relname`,
      [WORKER],
    );
    expect(granted.map((row) => row.relname)).toStrictEqual([]);
  });

  it('holds no usage on the ops schema', async () => {
    const [reach] = await db.admin.execute<{ readonly ops_usage: boolean }>(
      `select has_schema_privilege($1, 'ops', 'usage') as ops_usage`,
      [WORKER],
    );
    expect(reach?.ops_usage).toBe(false);
  });

  it('reaches the public schema, as every role does, and finds nothing in it', async () => {
    // Postgres grants USAGE on `public` to PUBLIC, and a grant to PUBLIC
    // cannot be revoked from one role. So this is not something 0008 could
    // have denied, and the honest statement is the one that matters: reaching
    // the schema is not reaching anything in it. The table assertion above is
    // the default-deny; this records why the schema one is not.
    const [reach] = await db.admin.execute<{ readonly public_usage: boolean }>(
      `select has_schema_privilege($1, 'public', 'usage') as public_usage`,
      [WORKER],
    );
    expect(reach?.public_usage).toBe(true);

    const anyObject = await db.admin.execute<{ readonly relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'S')
          and has_table_privilege($1, c.oid, 'select')`,
      [WORKER],
    );
    expect(anyObject.map((row) => row.relname)).toStrictEqual([]);
  });

  it('is not a member of the application role, which is where the grants are', async () => {
    const [member] = await db.admin.execute<{ readonly is_member: boolean }>(
      `select pg_has_role($1, 'ops_astro_app', 'member') as is_member`,
      [WORKER],
    );
    expect(member?.is_member).toBe(false);
  });
});
