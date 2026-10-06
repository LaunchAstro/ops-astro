// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  EXISTING_LOGINS,
  loginAddresses,
  loginsBeyondTheirGroup,
  statementsFor,
  type ExistingLogin,
} from '../../scripts/ops/staging-logins.ts';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it('an existing lookup login cannot retain direct data privileges when credentials are issued', async () => {
  const serverUrl = databaseUrlFromEnvironment();
  if (serverUrl === undefined) throw new Error('an isolated Postgres server is required');
  const db = await createEmptyDatabase({ part: 'ow066grants' });
  const role = 'ops_astro_lookup_login';
  try {
    await db.admin.execute(
      "do $$ begin if not exists (select from pg_roles where rolname='ops_astro_lookup') then create role ops_astro_lookup nologin; end if; end $$",
    );
    await db.admin.execute(
      `create role ${role} login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication`,
    );
    await db.admin.execute(`grant ops_astro_lookup to ${role} with inherit false`);
    await db.admin.execute('create table public.private_client_records (content text)');
    await db.admin.execute(
      "insert into public.private_client_records values ('synthetic private client content')",
    );
    await db.admin.execute(`grant select on public.private_client_records to ${role}`);
    const rows = await db.admin.execute<ExistingLogin>(EXISTING_LOGINS, [[role]]);
    const refusal = loginsBeyondTheirGroup(rows);
    if (refusal === undefined) {
      const addresses = loginAddresses(
        'postgresql://owner@aws-0-ap-southeast-2.pooler.supabase.com/postgres',
        'abcdefghijabcdefghij',
        'after-reset',
      ).filter(({ login }) => login.role === role);
      await db.admin.transaction(async (execute) => {
        // oxlint-disable-next-line no-await-in-loop -- the role, password and membership statements must run in order
        for (const statement of statementsFor('after-reset', addresses)) await execute(statement);
      });
      const url = new URL(serverUrl);
      url.pathname = `/${db.name}`;
      url.username = role;
      url.password = addresses[0]!.password;
      const login = connectAsAdmin(url.toString());
      try {
        let answer: unknown;
        try {
          const [read] = await login.execute<{ n: number }>(
            'select count(*)::int as n from public.private_client_records',
          );
          answer = read?.n;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error)) throw error;
          answer = error.code;
        }
        expect(
          answer,
          'the newly issued lookup credential must not retain direct client-data access',
        ).toBe('42501');
      } finally {
        await login.close();
      }
    }
  } finally {
    await db.drop();
    const server = connectAsAdmin(serverUrl);
    try {
      await server.execute(`drop role if exists ${role}`);
    } finally {
      await server.close();
    }
  }
});
