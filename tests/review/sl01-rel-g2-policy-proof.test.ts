// SPDX-License-Identifier: AGPL-3.0-only
// Narrow re-check proof for the G2 ruling's role-specific policy.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';

let db: FreshDatabase;

beforeAll(async () => {
  db = await createFreshDatabase({ part: 'relpolicy' });
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

it('G2 lookup uses a businesses-only policy without cluster-wide BYPASSRLS', async () => {
  const [role] = await db.admin.execute<{ rolbypassrls: boolean }>(
    "select rolbypassrls from pg_roles where rolname = 'ops_astro_lookup'",
  );
  const policies = await db.admin.execute<{ polname: string }>(
    `select p.polname from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'businesses'
        and (select oid from pg_roles where rolname = 'ops_astro_lookup') = any(p.polroles)`,
  );
  const problems = [
    ...(role?.rolbypassrls === false ? [] : ['BYPASSRLS']),
    ...(policies.length > 0 ? [] : ['no role-specific policy']),
  ];
  expect(problems).toStrictEqual([]);
});
