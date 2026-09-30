// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-1 no-production-data suites' shared helpers
// (staging-no-production-data.test.ts and staging-no-production-data-guard.test.ts):
// the seed as a process, and the made-up and planted rows.

import { randomUUID } from 'node:crypto';
import { databaseUrlFromEnvironment, type FreshDatabase } from '../support/fresh-database.ts';

type Admin = FreshDatabase['admin'];

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const USERS_FILE: string = new URL('../../.local/synthetic-users.json', import.meta.url)
  .pathname;

export const MADE_UP: string[] = ['alpha', 'bravo'];

/** The database as new: no guard, no mark, no rows, and the emptied tables' pages given back. */
export async function emptied(admin: Admin): Promise<void> {
  await admin.execute('drop event trigger if exists ops_astro_made_up_guard');
  await admin.execute('drop schema if exists ops_astro_made_up cascade');
  await admin.execute('delete from public.records');
  await admin.execute('delete from public.record_types');
  await admin.execute('delete from public.people');
  await admin.execute('delete from public.businesses');
  await admin.execute('delete from auth.users');
  const [unmark] = await admin.execute<{ statement: string }>(
    "select format('comment on database %I is null', current_database()) as statement",
  );
  await admin.execute(unmark!.statement);
  // Emptied tables give their pages back, so an emptied database is a new one.
  for (const table of ['public.records', 'public.record_types', 'public.people'])
    // oxlint-disable-next-line no-await-in-loop
    await admin.execute(`vacuum ${table}`);
  await admin.execute('vacuum public.businesses');
  await admin.execute('vacuum auth.users');
}

/** A business row, written on the owner's connection. */
export async function businessRow(admin: Admin, key: string): Promise<string> {
  const id = randomUUID();
  await admin.execute(
    'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
    [id, key, `${key} Pty Ltd`],
  );
  return id;
}
