// SPDX-License-Identifier: AGPL-3.0-only
//
// STAGING42501's hosted layout, shared by staging-guard-unowned-table and
// staging-guard-look-alikes: the guard's functions owned by a login that is not
// a superuser, as postgres is on hosted Supabase, and a second role that owns
// the stand-in auth.users and grants that login TRIGGER. The role names are
// cluster-wide, so each file that uses this makes its own and drops them.

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { guardMadeUp } from '../../scripts/ops/made-up-only.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();
export const GUARD: string = 'ops_astro_made_up_guard';
const suffix = randomBytes(4).toString('hex');
/** The admin login on hosted: owns the guard's functions, not auth.users. */
export const LOGIN: string = `sg_login_${suffix}`;
/** The provider's role that owns auth.users. */
export const PROVIDER: string = `sg_provider_${suffix}`;
const PASSWORD = randomBytes(24).toString('base64url');

async function server<T>(
  work: (admin: ReturnType<typeof connectAsAdmin>) => Promise<T>,
): Promise<T> {
  const admin = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
  try {
    return await work(admin);
  } finally {
    await admin.close();
  }
}

let db: EmptyDatabase | undefined;

/** The current case's superuser connection. */
export function caseAdmin(): EmptyDatabase['admin'] {
  if (db === undefined) throw new Error('staging-guard fixture: call hostedLike() first');
  return db.admin;
}

/** Run statements as `role` in one transaction on the superuser connection. */
export async function as(role: string, statement: string): Promise<void> {
  await caseAdmin().execute(`do $do$ begin set local role ${role}; ${statement}; end $do$`);
}

/** Where the guard on `table` stands: 'A', 'O', 'D', or undefined for none. */
export async function enabling(table: string): Promise<string | undefined> {
  const [row] =
    (await caseAdmin().execute<{ readonly tgenabled: string }>(
      `select tgenabled::text from pg_trigger where tgrelid = $1::regclass and tgname = '${GUARD}'`,
      [table],
    )) ?? [];
  return row?.tgenabled;
}

export async function ledger(): Promise<string[]> {
  const rows =
    (await caseAdmin().execute<{ readonly relation: string }>(
      'select relation from ops_astro_made_up.untrusted order by relation',
    )) ?? [];
  return rows.map((row) => row.relation);
}

export const forget = async (): Promise<void> => {
  await caseAdmin().execute('delete from ops_astro_made_up.untrusted');
};

/**
 * A database laid out as hosted Supabase is: the guard installed, its functions
 * owned by LOGIN; auth.users made by PROVIDER, which owns it and grants LOGIN
 * TRIGGER, as it does on public tables it makes; and public.owned_by_login, a
 * tenant table LOGIN owns. Each table is made after the guard, so the watch's
 * protect() guards it as LOGIN.
 */
export async function hostedLike(): Promise<EmptyDatabase> {
  db = await createEmptyDatabase({ part: 'sgua' });
  const { admin } = db;
  await admin.execute(`create schema auth authorization ${PROVIDER}`);
  await admin.execute(`grant usage on schema auth to ${LOGIN}`);
  for (const schema of ['auth', 'public'])
    // oxlint-disable-next-line no-await-in-loop
    await admin.execute(`alter default privileges for role ${PROVIDER} in schema ${schema}
      grant trigger on tables to ${LOGIN}`);
  await admin.execute(`grant usage, create on schema public to ${LOGIN}, ${PROVIDER}`);
  await guardMadeUp(admin);
  await admin.execute(`alter schema ops_astro_made_up owner to ${LOGIN}`);
  await admin.execute(`alter table ops_astro_made_up.untrusted owner to ${LOGIN}`);
  for (const fn of ['note(text)', 'guard()', 'watch()', 'protect(oid)'])
    // oxlint-disable-next-line no-await-in-loop
    await admin.execute(`alter function ops_astro_made_up.${fn} owner to ${LOGIN}`);
  await as(PROVIDER, 'create table auth.users (id uuid, email text)');
  await as(LOGIN, 'create table public.owned_by_login (business_id uuid, id uuid)');
  return db;
}

/** The made-up checks as LOGIN, the way the reset runs them on hosted. */
export async function asLogin<T>(
  work: (login: ReturnType<typeof connectAsAdmin>) => Promise<T>,
): Promise<T> {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db?.name ?? ''}`;
  url.username = LOGIN;
  url.password = PASSWORD;
  const login = connectAsAdmin(url.toString(), { source: 'login' });
  try {
    return await work(login);
  } finally {
    await login.close();
  }
}

/** The two roles before the cases and gone after; each case gets its own database. */
export function withRoles(): void {
  beforeAll(async () => {
    await server(async (admin) => {
      await admin.execute(`create role ${PROVIDER} nologin`);
      await admin.execute(`create role ${LOGIN} login password '${PASSWORD}' nosuperuser`);
      // The checks must not lean on how names print under the login's search path.
      await admin.execute(`alter role ${LOGIN} set search_path = auth, ops_astro_made_up, public`);
    });
  }, 60_000);

  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  afterAll(async () => {
    await server(async (admin) => {
      await admin.execute(`drop role if exists ${LOGIN}`);
      await admin.execute(`drop role if exists ${PROVIDER}`);
    });
  });
}
