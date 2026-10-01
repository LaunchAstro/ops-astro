// SPDX-License-Identifier: AGPL-3.0-only
//
// STAGING-FIX-2: a reset on hosted Supabase runs the migration runner and the
// made-up check beside the platform's own services, which never stop. Both
// accept those services by the exact role name each uses, and nothing wider:
// a look-alike name, a differently cased one and a Supabase role not on the
// list still refuse. Each case holds real sessions as those logins, or plants
// a real definer function owned by the role, on its own fresh database.
//
// The role names are cluster-wide, so this one file makes them and drops them
// around each describe, and its cases run in order.

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  connectAsAdmin,
  connectObserved,
  type AdminConnection,
  type ObservedPool,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  applyMigrations,
  MigrationRefused,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { markMadeUp, productionSigns } from '../../scripts/ops/made-up-only.ts';
import { syntheticMigration } from '../support/prefix-harness.ts';

const serverUrl = databaseUrlFromEnvironment();
const onDisk = readMigrations('migrations');
const PAST_ROW_SECURITY = 'a definer function runs as a role past row security';

/** Hosted Supabase's own service logins, as the platform names them. */
const SERVICES = [
  'authenticator',
  'pgbouncer',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
];
/** Near misses: a suffix, a different case, and a real Supabase role not named. */
const LOOK_ALIKES = [
  'supabase_adminx',
  'Supabase_Admin',
  'Supabase_Auth_Admin',
  'supabase_etl_admin',
];
/** Superuser or BYPASSRLS, as on hosted Supabase, so a definer they own is past row security. */
const PAST_RLS: Readonly<Record<string, string>> = {
  supabase_admin: 'superuser',
  supabase_adminx: 'superuser',
  Supabase_Admin: 'superuser',
  supabase_etl_admin: 'bypassrls',
};
const PASSWORD = randomBytes(24).toString('base64url');

async function server<T>(work: (admin: AdminConnection) => Promise<T>): Promise<T> {
  const admin = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
  try {
    return await work(admin);
  } finally {
    await admin.close();
  }
}

const ROLES = [...SERVICES, ...LOOK_ALIKES];
const held: ObservedPool[] = [];
const created: string[] = [];
let db: FreshDatabase | undefined;

/**
 * Make the roles before the cases and drop them after; each case gets its own
 * database. A server where any of them already exists, as hosted Supabase is,
 * is refused before anything changes: this suite alters and drops only roles
 * it made itself.
 */
function withHostedRoles(): void {
  beforeAll(async () => {
    await server(async (admin) => {
      const taken = await admin.execute<{ readonly rolname: string }>(
        `select rolname::text from pg_roles where rolname = any($1::text[])`,
        [ROLES],
      );
      if (taken.length > 0)
        throw new Error(
          `staging-hosted-roles: ${taken.map((r) => r.rolname).join(', ')} already exist on ` +
            'this server, so it is not a throwaway one; refusing to touch them',
        );
      for (const role of ROLES) {
        // oxlint-disable-next-line no-await-in-loop
        await admin.execute(
          `create role "${role}" login password '${PASSWORD}' ${PAST_RLS[role] ?? 'nosuperuser nobypassrls'}`,
        );
        created.push(role);
      }
    });
  }, 60_000);

  afterEach(async () => {
    await Promise.all(held.splice(0).map(async (pool) => await pool.close()));
    await db?.drop();
    db = undefined;
  });

  afterAll(async () => {
    const leaked: string[] = [];
    await server(async (admin) => {
      for (const role of created.splice(0))
        // oxlint-disable-next-line no-await-in-loop
        await admin.execute(`drop role if exists "${role}"`).catch(() => leaked.push(role));
    });
    if (leaked.length > 0)
      throw new Error(
        `staging-hosted-roles: made and left ${leaked.join(', ')}; drop them by hand`,
      );
  });
}

async function fresh(part: string): Promise<FreshDatabase> {
  db = await createFreshDatabase({ part });
  await db.closeSessions();
  return db;
}

/** A session held open on the database as `role`, and its backend's pid. */
async function holdAs(on: FreshDatabase, role: string): Promise<number> {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${on.name}`;
  url.username = encodeURIComponent(role);
  url.password = PASSWORD;
  const pool = connectObserved(url.toString(), { source: `held-${role}` });
  held.push(pool);
  const [row] = await pool.betweenTransactions<{ readonly pid: number }>(
    `select pg_backend_pid() as pid`,
  );
  if (row === undefined) throw new Error(`no pid for the session held as ${role}`);
  return row.pid;
}

/** The made-up signs of a marked database holding one definer function owned by `role`. */
async function definerOwnedBy(part: string, role: string): Promise<string[]> {
  const on = await fresh(part);
  await on.admin.execute('create schema if not exists auth');
  await on.admin.execute('create table if not exists auth.users (id uuid, email text)');
  await markMadeUp(on.admin, []);
  await on.admin.execute(
    `create function public.hosted_definer() returns int
       language sql security definer as 'select 1'`,
  );
  await on.admin.execute(`alter function public.hosted_definer() owner to "${role}"`);
  return productionSigns(on.admin);
}

describe.skipIf(serverUrl === undefined)('migrate beside hosted Supabase', () => {
  withHostedRoles();

  it('applies with only the platform services connected', async () => {
    const on = await fresh('hostedok');
    for (const role of SERVICES)
      // oxlint-disable-next-line no-await-in-loop
      await holdAs(on, role);
    const extra = syntheticMigration('9001_hosted_ok', 'select 1');

    const outcome = await applyMigrations(on.admin, [...onDisk, extra]);

    expect(outcome.applied).toStrictEqual(['9001_hosted_ok']);
  }, 120_000);

  it.each(LOOK_ALIKES)(
    'still refuses %s beside the platform services, naming only it',
    async (role) => {
      const on = await fresh('hostedno');
      for (const service of SERVICES)
        // oxlint-disable-next-line no-await-in-loop
        await holdAs(on, service);
      const pid = await holdAs(on, role);

      const outcome = await applyMigrations(on.admin, [
        ...onDisk,
        syntheticMigration('9001_hosted_no', 'select 1'),
      ]).catch((error: unknown) => error);

      if (!(outcome instanceof MigrationRefused)) throw outcome;
      expect(outcome.sessions.map((s) => ({ pid: s.pid, usename: s.usename }))).toStrictEqual([
        { pid, usename: role },
      ]);
    },
    120_000,
  );
});

describe.skipIf(serverUrl === undefined)('made-up-only beside hosted Supabase', () => {
  withHostedRoles();

  it('accepts a definer function owned by supabase_admin', async () => {
    expect(await definerOwnedBy('hosteddef', 'supabase_admin')).toStrictEqual([]);
  }, 120_000);

  it('still refuses one owned by a supabase_admin that is not a superuser', async () => {
    await server(
      async (admin) => await admin.execute('alter role supabase_admin nosuperuser bypassrls'),
    );
    try {
      expect(await definerOwnedBy('hostedbyp', 'supabase_admin')).toStrictEqual([
        PAST_ROW_SECURITY,
      ]);
    } finally {
      await server(async (admin) => await admin.execute('alter role supabase_admin superuser'));
    }
  }, 120_000);

  it.each(['supabase_adminx', 'Supabase_Admin', 'supabase_etl_admin'])(
    'still refuses a definer function owned by %s',
    async (role) => {
      expect(await definerOwnedBy('hostednodef', role)).toStrictEqual([PAST_ROW_SECURITY]);
    },
    120_000,
  );
});
