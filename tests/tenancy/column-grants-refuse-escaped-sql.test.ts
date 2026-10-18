// SPDX-License-Identifier: AGPL-3.0-only
//
// A reviewer's proof, kept as written apart from its title: a column grant
// spelt with an escape inside an E'' string is refused, never read as text.
import { expect, it } from 'vitest';
import { splitStatements } from '../../packages/core-records/src/tenancy/statements.ts';
import { columnGrants } from './migration-column-grants.ts';

it('refuses a column grant spelt with escapes in quoted SQL rather than skipping it', () => {
  const sql = String.raw`do $$ begin execute E'\x67rant update (state) on public.leases to ops_astro_lookup'; end $$;`;
  expect(() => columnGrants(splitStatements(sql))).toThrow(/statement 1/u);
});
