// SPDX-License-Identifier: AGPL-3.0-only
//
// STAGING42501, continued: a trigger under the made-up guard's name that
// protect() did not make never stands, at origin or enabled always, whichever
// of its fields differs. The hosted layout is staging-guard-unowned-table.fixture.ts.

import { describe, expect, it } from 'vitest';
import { markMadeUp, productionSigns } from '../../scripts/ops/made-up-only.ts';
import {
  caseAdmin,
  as,
  asLogin,
  forget,
  GUARD,
  hostedLike,
  PROVIDER,
  serverUrl,
  withRoles,
} from './staging-guard-unowned-table.fixture.ts';

describe.skipIf(serverUrl === undefined)('made-up guard look-alikes', () => {
  withRoles();
  lookAlikeCases();
  shapeCases();
});

/** Triggers under the guard's name that protect() did not make. */
function lookAlikeCases(): void {
  it('refuses an origin guard on an unowned table that is not the guard protect() makes', async () => {
    await hostedLike();
    await markMadeUp(caseAdmin(), []);
    await caseAdmin().execute(`drop trigger ${GUARD} on auth.users`);
    await caseAdmin().execute(`create function public.allow() returns trigger language plpgsql
      as $$ begin return null; end $$`);
    await caseAdmin().execute(`create trigger ${GUARD} after insert or update on auth.users
      for each row execute function public.allow('origin')`);
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);

  it('refuses an origin guard on a tenant table another role owns', async () => {
    await hostedLike();
    await markMadeUp(caseAdmin(), []);
    await caseAdmin().execute(`alter event trigger ${GUARD} disable`);
    await as(PROVIDER, 'create table public.provider_tenant (business_id uuid)');
    await caseAdmin()
      .execute(`create trigger ${GUARD} after insert or update on public.provider_tenant
      for each row execute function ops_astro_made_up.guard('origin')`);
    await caseAdmin().execute(`alter event trigger ${GUARD} enable always`);
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);

  it('refuses a look-alike guard enabled always on a table the login owns', async () => {
    await hostedLike();
    await markMadeUp(caseAdmin(), []);
    await caseAdmin().execute(`drop trigger ${GUARD} on public.owned_by_login`);
    await caseAdmin().execute(`create function public.allow() returns trigger language plpgsql
      as $$ begin return null; end $$`);
    await caseAdmin()
      .execute(`create trigger ${GUARD} after insert or update on public.owned_by_login
      for each row execute function public.allow()`);
    await caseAdmin().execute(`alter table public.owned_by_login enable always trigger ${GUARD}`);
    await forget();
    await asLogin(async (login) => {
      expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
    });
  }, 60_000);
}

/** protect()'s guard with one field changed, each fires less often than the guard. */
const SHAPES: Readonly<Record<string, string>> = {
  'on insert only': `create trigger ${GUARD} after insert on public.owned_by_login
    for each row execute function ops_astro_made_up.guard()`,
  'on update of one column': `create trigger ${GUARD} after insert or update of id
    on public.owned_by_login for each row execute function ops_astro_made_up.guard()`,
  'under a condition': `create trigger ${GUARD} after insert or update on public.owned_by_login
    for each row when (false) execute function ops_astro_made_up.guard()`,
  'with an argument': `create trigger ${GUARD} after insert or update on public.owned_by_login
    for each row execute function ops_astro_made_up.guard('origin')`,
  'deferred to commit': `create constraint trigger ${GUARD} after insert or update
    on public.owned_by_login deferrable initially deferred
    for each row execute function ops_astro_made_up.guard()`,
};

function shapeCases(): void {
  it.each(Object.entries(SHAPES))(
    "refuses a guard enabled always that is not protect()'s shape: %s",
    async (_shape, trigger) => {
      await hostedLike();
      await markMadeUp(caseAdmin(), []);
      await caseAdmin().execute(`drop trigger ${GUARD} on public.owned_by_login`);
      await caseAdmin().execute(trigger);
      await caseAdmin().execute(`alter table public.owned_by_login enable always trigger ${GUARD}`);
      await forget();
      await asLogin(async (login) => {
        expect(await productionSigns(login)).toEqual(['a table has no made-up guard']);
      });
    },
    60_000,
  );
}
