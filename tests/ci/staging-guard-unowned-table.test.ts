// SPDX-License-Identifier: AGPL-3.0-only
//
// STAGING42501: on hosted Supabase the reset's admin login holds TRIGGER on
// auth.users but does not own it (supabase_auth_admin does), so it cannot
// enable the made-up guard always there. The guard stands at origin on a table
// the login does not own, and stays enabled always on one it owns; the watch
// and the mark's check accept origin only on such a table.
//
// As on hosted, the guard's functions run as a login that is not a superuser,
// and a second role owns the stand-in auth.users and grants that login TRIGGER.
// The role names are cluster-wide, so this file makes its own and drops them.

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  guardMadeUp,
  markMadeUp,
  productionSigns,
  resettable,
} from '../../scripts/ops/made-up-only.ts';

const serverUrl = databaseUrlFromEnvironment();
const GUARD = 'ops_astro_made_up_guard';
const suffix = randomBytes(4).toString('hex');
/** The admin login on hosted: owns the guard's functions, not auth.users. */
const LOGIN = `sg_login_${suffix}`;
/** The provider's role that owns auth.users. */
const PROVIDER = `sg_provider_${suffix}`;
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

/** Run statements as `role` in one transaction on the superuser connection. */
async function as(role: string, statement: string): Promise<void> {
  await db?.admin.execute(`do $do$ begin set local role ${role}; ${statement}; end $do$`);
}

/** Where the guard on `table` stands: 'A', 'O', 'D', or undefined for none. */
async function enabling(table: string): Promise<string | undefined> {
  const [row] =
    (await db?.admin.execute<{ readonly tgenabled: string }>(
      `select tgenabled::text from pg_trigger where tgrelid = $1::regclass and tgname = '${GUARD}'`,
      [table],
    )) ?? [];
  return row?.tgenabled;
}

async function ledger(): Promise<string[]> {
  const rows =
    (await db?.admin.execute<{ readonly relation: string }>(
      'select relation from ops_astro_made_up.untrusted order by relation',
    )) ?? [];
  return rows.map((row) => row.relation);
}

const forget = async (): Promise<void> => {
  await db?.admin.execute('delete from ops_astro_made_up.untrusted');
};

/**
 * A database laid out as hosted Supabase is: the guard installed, its functions
 * owned by LOGIN; auth.users made by PROVIDER, which owns it and grants LOGIN
 * TRIGGER, as it does on public tables it makes; and public.owned_by_login, a
 * tenant table LOGIN owns. Each table is made after the guard, so the watch's
 * protect() guards it as LOGIN.
 */
async function hostedLike(): Promise<EmptyDatabase> {
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
async function asLogin<T>(
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

describe.skipIf(serverUrl === undefined)('made-up guard on a table the login does not own', () => {
  withRoles();
  protectCases();
  watchCases();
  handedCases();
  markCases();
  lookAlikeCases();
});

/** The two roles before the cases and gone after; each case gets its own database. */
function withRoles(): void {
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

function protectCases(): void {
  it('guards a table it does not own at origin, called by the watch or directly', async () => {
    await hostedLike();
    expect(await enabling('auth.users')).toBe('O');
    await db?.admin.execute(`drop trigger ${GUARD} on auth.users`);
    await db?.admin.execute(`select ops_astro_made_up.protect('auth.users'::regclass)`);
    expect(await enabling('auth.users')).toBe('O');
  }, 60_000);

  it('fires at origin in an ordinary session: a real address is noted, a made-up one is not', async () => {
    await hostedLike();
    await as(PROVIDER, `insert into auth.users values (gen_random_uuid(), 'ada@alpha.local')`);
    expect(await ledger()).toEqual([]);
    await db?.admin.execute(`insert into auth.users values (gen_random_uuid(), 'lee@example.com')`);
    expect(await ledger()).toEqual(['auth.users']);
  }, 60_000);

  it('keeps a table the login owns enabled always', async () => {
    await hostedLike();
    expect(await enabling('public.owned_by_login')).toBe('A');
  }, 60_000);

  it('refuses, as before, a tenant table another role owns', async () => {
    await hostedLike();
    await expect(
      as(PROVIDER, 'create table public.provider_tenant (business_id uuid)'),
    ).rejects.toThrow(/must be owner/u);
  }, 60_000);
}

function watchCases(): void {
  it('lets the provider alter its table at origin, and notes a guard turned down anywhere else', async () => {
    await hostedLike();
    await as(PROVIDER, 'alter table auth.users add column phone text');
    expect(await ledger()).toEqual([]);
    await as(PROVIDER, `alter table auth.users disable trigger ${GUARD}`);
    expect(await ledger()).toEqual(['guard']);
    await forget();
    await as(LOGIN, `alter table public.owned_by_login enable trigger ${GUARD}`);
    expect(await enabling('public.owned_by_login')).toBe('O');
    expect(await ledger()).toEqual(['guard']);
    await forget();
    await as(LOGIN, `alter table public.owned_by_login disable trigger ${GUARD}`);
    expect(await ledger()).toEqual(['guard']);
  }, 60_000);

  it('notes an origin guard on a table handed from or to the login', async () => {
    await hostedLike();
    await db?.admin.execute(`alter table public.owned_by_login owner to ${PROVIDER}`);
    expect(await ledger()).toEqual([]);
    await as(PROVIDER, `alter table public.owned_by_login enable trigger ${GUARD}`);
    expect(await ledger()).toEqual(['guard']);
    await forget();
    // The other way: an origin guard whose table the login comes to own.
    await db?.admin.execute(`alter table auth.users owner to ${LOGIN}`);
    expect(await ledger()).toEqual(['guard']);
  }, 60_000);
}

function handedCases(): void {
  it('notes a guard made always on auth.users, handed to the provider and turned down', async () => {
    await hostedLike();
    await db?.admin.execute(`alter table auth.users owner to ${LOGIN}`);
    await db?.admin.execute(`drop trigger ${GUARD} on auth.users`);
    await db?.admin.execute(`select ops_astro_made_up.protect('auth.users'::regclass)`);
    expect(await enabling('auth.users')).toBe('A');
    await db?.admin.execute(`alter table auth.users owner to ${PROVIDER}`);
    await forget();
    await as(PROVIDER, `alter table auth.users enable trigger ${GUARD}`);
    expect(await ledger()).toEqual(['guard']);
  }, 60_000);
}

function markCases(): void {
  it('vouches for a marked database whose unowned sign-in table is guarded at origin', async () => {
    await hostedLike();
    await markMadeUp(db?.admin ?? (undefined as never), []);
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual([]);
      expect(await resettable(login)).toBe(true);
    });
    await as(LOGIN, `alter table public.owned_by_login enable trigger ${GUARD}`);
    await forget();
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);

  it('refuses an origin guard on auth.users once the login owns it', async () => {
    await hostedLike();
    await markMadeUp(db?.admin ?? (undefined as never), []);
    await db?.admin.execute(`alter table auth.users owner to ${LOGIN}`);
    await forget();
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);
}

/** Triggers under the guard's name that protect() did not make. */
function lookAlikeCases(): void {
  it('refuses an origin guard on an unowned table that is not the guard protect() makes', async () => {
    await hostedLike();
    await markMadeUp(db?.admin ?? (undefined as never), []);
    await db?.admin.execute(`drop trigger ${GUARD} on auth.users`);
    await db?.admin.execute(`create function public.allow() returns trigger language plpgsql
      as $$ begin return null; end $$`);
    await db?.admin.execute(`create trigger ${GUARD} after insert or update on auth.users
      for each row execute function public.allow('origin')`);
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);

  it('refuses an origin guard on a tenant table another role owns', async () => {
    await hostedLike();
    await markMadeUp(db?.admin ?? (undefined as never), []);
    await db?.admin.execute(`alter event trigger ${GUARD} disable`);
    await as(PROVIDER, 'create table public.provider_tenant (business_id uuid)');
    await db?.admin
      .execute(`create trigger ${GUARD} after insert or update on public.provider_tenant
      for each row execute function ops_astro_made_up.guard('origin')`);
    await db?.admin.execute(`alter event trigger ${GUARD} enable always`);
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);

  it('refuses a look-alike guard enabled always on a table the login owns', async () => {
    await hostedLike();
    await markMadeUp(db?.admin ?? (undefined as never), []);
    await db?.admin.execute(`drop trigger ${GUARD} on public.owned_by_login`);
    await db?.admin.execute(`create function public.allow() returns trigger language plpgsql
      as $$ begin return null; end $$`);
    await db?.admin.execute(`create trigger ${GUARD} after insert or update on public.owned_by_login
      for each row execute function public.allow()`);
    await db?.admin.execute(`alter table public.owned_by_login enable always trigger ${GUARD}`);
    await forget();
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);
}
