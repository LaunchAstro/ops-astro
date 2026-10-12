// SPDX-License-Identifier: AGPL-3.0-only
//
// When the migration that checks the backup identity's reach stops a staging
// reset, the reset names what the backup identity cannot read, so the
// operator knows which schema or table to fix. A grant that gives nothing is
// stood in for by a table whose read is taken back after every grant.

import { expect, it } from 'vitest';
import { stoppedBecause } from '../../scripts/ops/staging-reset-stops.ts';
import {
  onDatabase,
  quiet,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset stopped by the backup reach check names the table the backup identity cannot read',
  async () => {
    await onDatabase(async (admin) => {
      await admin.execute('create schema reach_gap');
      await admin.execute('create table auth.unread_by_backup (x int)');
      await admin.execute(`create function reach_gap.take_back() returns event_trigger
        language plpgsql as $$ begin
          revoke select on auth.unread_by_backup from ops_astro_backup;
        end $$`);
      await admin.execute(`create event trigger reach_gap_take_back on ddl_command_end
        when tag in ('GRANT') execute function reach_gap.take_back()`);
    });

    const result = await run(settings());

    expect(result.status).toBe(1);
    expect(result.out).toContain(
      'stopped while migrating (the backup identity cannot read auth.unread_by_backup)',
    );
    quiet(result);
  },
  360_000,
);

/** An error as the migration runner throws it: its own message, the database's as its cause. */
function failedMigration(code: string, message: string): Error {
  const cause = Object.assign(new Error(message), { code });
  return new Error('migrate: 20261006140500_backup_reach_checked failed on: do $$ ...', { cause });
}

it('names the schemas and tables the backup identity cannot read', () => {
  const gap = 'the backup identity cannot read ops_astro_made_up.unread_by_backup, schema auth';
  expect(stoppedBecause(failedMigration('42501', gap))).toBe(gap);
});

it.each([
  ['another permission error', '42501', 'permission denied for table secrets'],
  [
    'the gap with an address in it',
    '42501',
    'the backup identity cannot read db.example.test:5432/x',
  ],
  ['the gap under another SQLSTATE', '42P01', 'the backup identity cannot read ops.x'],
  ['a quoted identifier', '42501', 'the backup identity cannot read "Odd name".t'],
])('tells %s by its class and SQLSTATE alone', (_label, code, message) => {
  expect(stoppedBecause(failedMigration(code, message))).toBe('Error');
  expect(stoppedBecause(Object.assign(new Error(message), { code }))).toBe(`Error ${code}`);
});
