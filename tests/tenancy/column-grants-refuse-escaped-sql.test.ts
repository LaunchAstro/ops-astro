// SPDX-License-Identifier: AGPL-3.0-only
//
// A reviewer's proofs, kept as written apart from their titles: a column
// grant spelt with a hex or an octal escape inside an E'' string is refused,
// never read as text.
import { expect, it } from 'vitest';
import { splitStatements } from '../../packages/core-records/src/tenancy/statements.ts';
import { columnGrants } from './migration-column-grants.ts';

it('refuses a column grant spelt with escapes in quoted SQL rather than skipping it', () => {
  const sql = String.raw`do $$ begin execute E'\x67rant update (state) on public.leases to ops_astro_lookup'; end $$;`;
  expect(() => columnGrants(splitStatements(sql))).toThrow(/statement 1/u);
});

it('refuses a column grant spelt with an octal escape PostgreSQL truncates to a byte', () => {
  const sql = String.raw`do $$ begin execute E'\547rant update (state) on public.leases to ops_astro_lookup'; end $$;`;
  expect(() => columnGrants(splitStatements(sql))).toThrow(/statement 1/u);
});
