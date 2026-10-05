// SPDX-License-Identifier: AGPL-3.0-only
//
// 20261005063514: the admin login may take the two identities it acts as. On
// hosted Supabase (Postgres 17) the admin login is not a superuser, and each
// role a migration made is granted to it with ADMIN OPTION alone (no SET, no
// INHERIT), so `set local role` is refused 42501. Two places take a role on
// the admin login: the business resolver behind the operator gate
// (apps/api/server.ts, ops_astro_lookup) and the restore drill's stamp
// (scripts/ops/tested-restore.ts, ops_astro_restore_drill). Asked of logins
// shaped like hosted's on a migrated database, the migration:
// - lets a login holding each with ADMIN OPTION alone take it by name;
// - gives that login none of either identity's privileges without the role;
// - gives a login without ADMIN OPTION nothing, and does not fail;
// - changes nothing when run again;
// - changes nothing for a superuser, even one holding ADMIN OPTION alone.

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
const IDENTITIES = ['ops_astro_lookup', 'ops_astro_restore_drill'] as const;
const GRANT =
  readMigrations('migrations').find(
    (m) => m.version === '20261005063514_admin_login_takes_identity_roles',
  )?.statements ?? [];

/** A login of its own, as the test made it, with the notices its session raised. */
interface Login {
  readonly name: string;
  readonly sql: postgres.Sql;
  readonly notices: string[];
}

let db: FreshDatabase;
let admin: Login;
const logins: Login[] = [];

/**
 * A login on `db`, made `attributes` (always INHERIT, as hosted's admin login
 * is, so a grant that leaves INHERIT to its default would inherit), holding
 * each of `holds` with the options named.
 */
async function login(
  suffix: string,
  attributes: string,
  holds: Partial<Record<(typeof IDENTITIES)[number], string>>,
): Promise<Login> {
  const name = `${db.name}_${suffix}`;
  const password = randomBytes(18).toString('base64url');
  await db.admin.execute(
    `create role "${name}" login inherit ${attributes} password '${password}'`,
  );
  await db.admin.execute(`grant connect on database "${db.name}" to "${name}"`);
  for (const [role, options] of Object.entries(holds)) {
    // oxlint-disable-next-line no-await-in-loop -- one grant after another
    await db.admin.execute(`grant ${role} to "${name}" with ${options}`);
  }
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  url.username = name;
  url.password = password;
  const notices: string[] = [];
  const sql = postgres(url.toString(), {
    max: 1,
    onnotice: (notice) => notices.push(String(notice['message'])),
  });
  const made = { name, sql, notices };
  logins.push(made);
  return made;
}

/** The migration's statements, run on `as`'s own session, as its migrator would. */
async function migrateAs(as: Login): Promise<void> {
  await as.sql.begin(async (tx) => {
    for (const statement of GRANT) {
      // oxlint-disable-next-line no-await-in-loop -- in the file's order
      await tx.unsafe(statement);
    }
  });
}

/** The SQLSTATE `statement` fails with on `as`'s session, or 'ok'. Rolled back. */
async function attempt(as: Login, statement: string): Promise<string> {
  try {
    await as.sql.begin(async (tx) => {
      await tx.unsafe(statement);
      throw new Error('rolled back');
    });
  } catch (error) {
    return (error as { code?: string }).code ?? 'ok';
  }
  return 'ok';
}

/** Each identity `as` may take by name, `set local role`'s answer per identity. */
const takes = async (as: Login): Promise<string[]> =>
  await Promise.all(IDENTITIES.map(async (role) => await attempt(as, `set local role ${role}`)));

/** Every membership `member` holds in an identity, as the catalogue has it. */
async function memberships(member: string): Promise<string[]> {
  const rows = await db.admin.execute<{ held: string }>(
    `select format('%s by %s admin=%s inherit=%s set=%s', m.roleid::regrole, m.grantor::regrole,
                   m.admin_option, m.inherit_option, m.set_option) as held
       from pg_auth_members m
      where m.member = (select oid from pg_roles where rolname = $1)
        and m.roleid::regrole::text = any($2)
      order by 1`,
    [member, [...IDENTITIES]],
  );
  return rows.map((row) => row.held);
}

describe.skipIf(serverUrl === undefined)('the admin login takes the identities it acts as', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'adml' });
    const shaped = Object.fromEntries(
      IDENTITIES.map((role) => [role, 'admin true, inherit false, set false']),
    );
    admin = await login('ad', 'nosuperuser createrole', shaped);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(logins.map(async ({ sql }) => await sql.end()));
    await db?.drop();
    // The logins are the cluster's: each one's own grants go first, then it.
    const cleanup = postgres(serverUrl ?? '', { max: 1, onnotice: () => {} });
    try {
      for (const { name } of logins) {
        // oxlint-disable-next-line no-await-in-loop -- one login after another
        await cleanup.unsafe(
          `do $$ declare held record; begin
             for held in select roleid::regrole::text as role from pg_auth_members
                          where grantor = (select oid from pg_roles where rolname = '${name}')
             loop execute format('revoke %s from %I granted by %I', held.role, '${name}', '${name}');
             end loop; end $$`,
        );
        // oxlint-disable-next-line no-await-in-loop -- one login after another
        await cleanup.unsafe(`drop role if exists "${name}"`);
      }
    } finally {
      await cleanup.end();
    }
  });

  grantCases();
  rerunCases();
});

function grantCases() {
  it('a login holding each identity with ADMIN OPTION alone takes it by name once migrated', async () => {
    const before = await takes(admin);
    await migrateAs(admin);
    expect({ before, after: await takes(admin) }).toStrictEqual({
      before: ['42501', '42501'],
      after: ['ok', 'ok'],
    });
  });

  it('the migrated admin login holds neither identity’s privileges without taking it', async () => {
    const shown = await admin.sql<{ set: boolean; usage: boolean }[]>`
      select pg_has_role(current_user, r, 'SET') as set, pg_has_role(current_user, r, 'USAGE') as usage
        from unnest(${[...IDENTITIES]}::text[]) r`;
    expect(shown.map(({ set, usage }) => ({ set, usage }))).toStrictEqual([
      { set: true, usage: false },
      { set: true, usage: false },
    ]);
    // Only the lookup identity reads businesses' keys; only the drill's stamps.
    expect(
      await Promise.all([
        attempt(admin, 'select id, key from public.businesses limit 1'),
        attempt(admin, 'select ops.record_tested_restore()'),
      ]),
    ).toStrictEqual(['42501', '42501']);
  });

  it('a login without ADMIN OPTION gains nothing and the migration still succeeds', async () => {
    const member = await login('mb', 'nosuperuser createrole', {
      ops_astro_lookup: 'admin false, inherit false, set false',
    });
    const held = await memberships(member.name);
    expect(await attempt(member, 'select 1')).toBe('ok');
    await migrateAs(member);
    expect({ held: await memberships(member.name), takes: await takes(member) }).toStrictEqual({
      held,
      takes: ['42501', '42501'],
    });
  });
}

function rerunCases() {
  it('running the migration again changes nothing and grants nothing', async () => {
    const held = await memberships(admin.name);
    admin.notices.length = 0;
    await migrateAs(admin);
    expect({ held: await memberships(admin.name), notices: admin.notices }).toStrictEqual({
      held,
      notices: [],
    });
  });

  it('a superuser login is unchanged, even one holding the identities with ADMIN OPTION alone', async () => {
    const shaped = Object.fromEntries(
      IDENTITIES.map((role) => [role, 'admin true, inherit false, set false']),
    );
    const owner = await login('su', 'superuser', shaped);
    const [local] = await db.admin.execute<{ name: string }>('select current_user as name');
    const before = [await memberships(owner.name), await memberships(local?.name ?? '')];
    await migrateAs(owner);
    await db.admin.transaction(async (execute) => {
      for (const statement of GRANT) {
        // oxlint-disable-next-line no-await-in-loop -- in the file's order
        await execute(statement);
      }
    });
    expect([await memberships(owner.name), await memberships(local?.name ?? '')]).toStrictEqual(
      before,
    );
    expect(owner.notices).toStrictEqual([]);
  });
}
