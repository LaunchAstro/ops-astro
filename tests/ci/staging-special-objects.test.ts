// SPDX-License-Identifier: AGPL-3.0-only
// S0-1 no production data, the owner's option A for the guard (NATHAN-GUARD-A):
// staging refuses to start while an object of the three kinds Sol found exists,
// each refusal named: a view over a private table owned by a role other than
// the app role; a security definer function owned by another role with
// BYPASSRLS, superuser or database-owner membership; the writer tag readable in
// another session's SQL. A clean staging passes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { markMadeUp, productionSigns, SEED_TAG } from '../../scripts/ops/made-up-only.ts';
import { serverUrl } from './staging-no-production-data.fixture.ts';

let db: FreshDatabase;

describe.skipIf(serverUrl === undefined)('S0-1 staging special objects', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's01o' });
    await db.admin.execute('create schema if not exists auth');
    await db.admin.execute('create table if not exists auth.users (id uuid, email text)');
    await markMadeUp(db.admin, []);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('a clean staging passes', async () => {
    expect(await productionSigns(db.admin)).toStrictEqual([]);
  });

  plantedCases();
});

function plantedCases() {
  it('refuses an owner view over a private table, by name', async () => {
    await db.admin.execute('create view public.planted_people as select * from public.people');
    try {
      expect(await productionSigns(db.admin)).toStrictEqual([
        'a view over a private table runs as a role other than the app role',
      ]);
    } finally {
      await db.admin.execute('drop view public.planted_people');
    }
  });

  it('refuses a definer function owned by another bypass-RLS role, by name', async () => {
    const role = `${db.name}_planted`;
    await db.admin.execute(`create role "${role}" bypassrls nologin`);
    try {
      await db.admin.execute(`grant create on schema public to "${role}"`);
      await db.admin.execute(
        'create function public.planted() returns void language sql security definer as $$ select $$',
      );
      await db.admin.execute(`alter function public.planted() owner to "${role}"`);
      expect(await productionSigns(db.admin)).toStrictEqual([
        'a definer function runs as a role past row security',
      ]);
    } finally {
      await db.admin.execute(`drop owned by "${role}" cascade`);
      await db.admin.execute(`drop role "${role}"`);
    }
  });

  it('refuses while the writer tag is readable in another session, by name', async () => {
    const url = new URL(serverUrl ?? '');
    url.pathname = `/${db.name}`;
    const other = connectAsAdmin(url.toString(), { source: 'planted-tag' });
    try {
      await other.execute(`select 1 from ${SEED_TAG}`);
      expect(await productionSigns(db.admin)).toStrictEqual([
        'the seed tag is readable in another session',
      ]);
    } finally {
      await other.close();
    }
  });
}
