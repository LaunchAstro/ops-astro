// SPDX-License-Identifier: AGPL-3.0-only
//
// #999, Sol PRV-oa-1070-R1: when migration 20261006140500 stops a staging
// reset, the reset names what the backup identity cannot read. Any other
// database error is still told by its class and SQLSTATE alone, since its
// message may carry an address.
import { expect, it } from 'vitest';
import { stoppedBecause } from '../../scripts/ops/staging-reset.ts';

/** An error as migrate() throws it: its own message, the database's as its cause. */
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
