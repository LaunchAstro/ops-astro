// SPDX-License-Identifier: AGPL-3.0-only
//
// A reviewer's proofs, kept as written apart from their titles: a column
// grant spelt with a hex or an octal escape inside an E'' string is refused,
// never read as text, and so is a literal-backslash escape outside the one
// migration read by hand.
import { expect, it } from 'vitest';
import { splitStatements } from '../../packages/core-records/src/tenancy/statements.ts';
import { columnGrants, migrationColumnGrants } from './migration-column-grants.ts';

it('refuses a column grant spelt with escapes in quoted SQL rather than skipping it', () => {
  const sql = String.raw`do $$ begin execute E'\x67rant update (state) on public.leases to ops_astro_lookup'; end $$;`;
  expect(() => columnGrants(splitStatements(sql))).toThrow(/statement 1/u);
});

it('refuses a column grant spelt with an octal escape PostgreSQL truncates to a byte', () => {
  const sql = String.raw`do $$ begin execute E'\547rant update (state) on public.leases to ops_astro_lookup'; end $$;`;
  expect(() => columnGrants(splitStatements(sql))).toThrow(/statement 1/u);
});

it('refuses a literal-backslash escape in an E string in any migration not read by hand', () => {
  const slash = String.fromCharCode(92);
  const sql = `select strpos(x, E'${slash}${slash}') from s.t;`;
  const migration = {
    version: '20261018120000_sol_literal_escape',
    statements: splitStatements(sql),
  };
  expect(() => migrationColumnGrants(migration)).toThrow(/statement 1/u);
});
