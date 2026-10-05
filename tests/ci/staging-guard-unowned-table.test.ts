// SPDX-License-Identifier: AGPL-3.0-only
//
// STAGING42501: on hosted Supabase the reset's admin login holds TRIGGER on
// auth.users but does not own it (supabase_auth_admin does), so it cannot
// enable the made-up guard always there. The guard stands at origin on
// auth.users while the login does not own it, and stays enabled always on every
// other table it guards; the watch and the mark's check accept origin only there.
//
// The hosted layout is staging-guard-unowned-table.fixture.ts; triggers under
// the guard's name that protect() did not make are staging-guard-look-alikes.

import { describe, expect, it } from 'vitest';
import { markMadeUp, productionSigns, resettable } from '../../scripts/ops/made-up-only.ts';
import {
  caseAdmin,
  as,
  asLogin,
  enabling,
  forget,
  GUARD,
  hostedLike,
  ledger,
  LOGIN,
  PROVIDER,
  serverUrl,
  withRoles,
} from './staging-guard-unowned-table.fixture.ts';

describe.skipIf(serverUrl === undefined)(
  'made-up guard on auth.users the login does not own',
  () => {
    withRoles();
    protectCases();
    watchCases();
    handedCases();
    markCases();
  },
);

function protectCases(): void {
  it('guards a table it does not own at origin, called by the watch or directly', async () => {
    await hostedLike();
    expect(await enabling('auth.users')).toBe('O');
    await caseAdmin().execute(`drop trigger ${GUARD} on auth.users`);
    await caseAdmin().execute(`select ops_astro_made_up.protect('auth.users'::regclass)`);
    expect(await enabling('auth.users')).toBe('O');
  }, 60_000);

  // The provider cannot reach the guard's schema (revoked from public), so its
  // own real address fails at the note and never lands; a superuser's is noted.
  it('fires at origin in an ordinary session: a real address is refused or noted, a made-up one passes', async () => {
    await hostedLike();
    await as(PROVIDER, `insert into auth.users values (gen_random_uuid(), 'ada@alpha.local')`);
    expect(await ledger()).toEqual([]);
    await expect(
      as(PROVIDER, `insert into auth.users values (gen_random_uuid(), 'kim@example.com')`),
    ).rejects.toThrow(/permission denied for schema ops_astro_made_up/u);
    await caseAdmin().execute(
      `insert into auth.users values (gen_random_uuid(), 'lee@example.com')`,
    );
    expect(await ledger()).toEqual(['auth.users']);
    const rows = await caseAdmin().execute<{ readonly email: string }>(
      `select email from auth.users where email not like '%.local'`,
    );
    expect(rows.map((row) => row.email)).toEqual(['lee@example.com']);
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
    await caseAdmin().execute(`alter table public.owned_by_login owner to ${PROVIDER}`);
    expect(await ledger()).toEqual([]);
    await as(PROVIDER, `alter table public.owned_by_login enable trigger ${GUARD}`);
    expect(await ledger()).toEqual(['guard']);
    await forget();
    // The other way: an origin guard whose table the login comes to own.
    await caseAdmin().execute(`alter table auth.users owner to ${LOGIN}`);
    expect(await ledger()).toEqual(['guard']);
  }, 60_000);
}

function handedCases(): void {
  it('notes a guard made always on auth.users, handed to the provider and turned down', async () => {
    await hostedLike();
    await caseAdmin().execute(`alter table auth.users owner to ${LOGIN}`);
    await caseAdmin().execute(`drop trigger ${GUARD} on auth.users`);
    await caseAdmin().execute(`select ops_astro_made_up.protect('auth.users'::regclass)`);
    expect(await enabling('auth.users')).toBe('A');
    await caseAdmin().execute(`alter table auth.users owner to ${PROVIDER}`);
    await forget();
    await as(PROVIDER, `alter table auth.users enable trigger ${GUARD}`);
    expect(await ledger()).toEqual(['guard']);
  }, 60_000);
}

function markCases(): void {
  it('vouches for a marked database whose unowned sign-in table is guarded at origin', async () => {
    await hostedLike();
    await markMadeUp(caseAdmin(), []);
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
    await markMadeUp(caseAdmin(), []);
    await caseAdmin().execute(`alter table auth.users owner to ${LOGIN}`);
    await forget();
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);
}
