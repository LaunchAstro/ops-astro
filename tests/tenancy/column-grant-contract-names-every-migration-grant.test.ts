// SPDX-License-Identifier: AGPL-3.0-only
//
// The column-grant contract names every column grant the migrations make,
// read from their text with no database (migration-column-grants.ts), so a
// pull request finds a missing contract line before the merge queue does. The
// database suites still hold the contract against the migrated catalogue.

import { describe, expect, it } from 'vitest';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import { splitStatements } from '../../packages/core-records/src/tenancy/statements.ts';
import { APPLICATION_ROLE } from '../../scripts/migrated-template.ts';
import { columnGrants } from './migration-column-grants.ts';
import { columnUpdatesAt, roleColumnGrantsAt } from './restricted-calls-catalogue.ts';

const migrations = readMigrations(new URL('../../migrations', import.meta.url).pathname);
const contract = new Set([
  ...columnUpdatesAt().map((pair) => `${APPLICATION_ROLE} UPDATE ${pair}`),
  ...roleColumnGrantsAt(),
]);
const uncontracted = (statements: readonly string[]): string[] =>
  columnGrants(statements).filter((line) => !contract.has(line));
const read = (sql: string): string[] => columnGrants(splitStatements(sql));

describe('the column-grant contract, against the migrations', () => {
  it('names every column grant a migration makes', () => {
    const found = migrations.flatMap((migration) => columnGrants(migration.statements));
    // Non-vacuous: the reader finds the grants the contract was written from.
    expect(found).toContain('ops_astro_lookup SELECT public.businesses.key');
    expect(found).toContain(`${APPLICATION_ROLE} UPDATE public.leases.state`);
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter((line) => !contract.has(line))).toStrictEqual([]);
  });

  it('fails on a new migration whose column grants the contract does not name', () => {
    const planted = [
      ...migrations.flatMap((migration) => migration.statements),
      'grant select (message_digest), insert (message_digest) on ops.auth_hook_messages to ops_astro_app',
    ];
    expect(uncontracted(planted)).toStrictEqual([
      'ops_astro_app SELECT ops.auth_hook_messages.message_digest',
      'ops_astro_app INSERT ops.auth_hook_messages.message_digest',
    ]);
  });
});

/** A grant, and the column grants read from it. */
const READS: readonly (readonly [string, string, readonly string[]])[] = [
  [
    'upper case and tabs',
    'GRANT\tUPDATE (A, b)\nON TABLE Public.T TO R;',
    ['r UPDATE public.t.a', 'r UPDATE public.t.b'],
  ],
  [
    'quoted names keep their case',
    'grant select ("Col") on "S"."T" to "Role";',
    ['Role SELECT S.T.Col'],
  ],
  [
    'comments between every word',
    'grant /* x */ update -- y\n (a) /* (b) */ on s.t to r;',
    ['r UPDATE s.t.a'],
  ],
  ['nested block comments', 'grant update (a) /* /* */ (b) */ on s.t to r;', ['r UPDATE s.t.a']],
  [
    'all privileges on a column list',
    'grant all privileges (a) on s.t to r;',
    ['r SELECT s.t.a', 'r INSERT s.t.a', 'r UPDATE s.t.a', 'r REFERENCES s.t.a'],
  ],
  [
    'two tables, two grantees and a grant option',
    'grant insert (a) on s.t, s.u to group r, q with grant option granted by o;',
    ['r INSERT s.t.a', 'r INSERT s.u.a', 'q INSERT s.t.a', 'q INSERT s.u.a'],
  ],
  [
    'a table-level privilege beside a column one',
    'grant select, update (a) on s.t to r;',
    ['r UPDATE s.t.a'],
  ],
  [
    'a grant inside a comment',
    '-- grant update (a) on s.t to r;\n/* grant update (b) on s.t to r; */',
    [],
  ],
  [
    'a role grant from format with %I',
    "do $$ begin execute format('grant r to %I', current_user); end $$;",
    [],
  ],
  [
    'a function grant from a string',
    "do $$ begin execute 'grant execute on function s.f(text) to r'; end $$;",
    [],
  ],
];

/** What the reader refuses rather than skips: each is a column grant it cannot vouch for. */
const REFUSALS: readonly (readonly [string, string])[] = [
  ['a column grant on a table with no schema', 'grant update (a) on t to r;'],
  ['a column grant to current_user', 'grant update (a) on s.t to current_user;'],
  ['a column privilege that is not one', 'grant execute (a) on s.t to r;'],
  ['a column grant on every table in a schema', 'grant update (a) on all tables in schema s to r;'],
  ['an expression for a column', 'grant update (a + b) on s.t to r;'],
  ['an unbalanced column list', 'grant update (a on s.t to r;'],
  ['an unterminated block comment', 'grant update (a) on s.t to r /* ;'],
  ['a column grant in a string, even one only selected', "select 'grant update (a) on s.t to r';"],
  [
    'a column grant run from a string',
    "do $$ begin execute 'grant update (a) on s.t to r'; end $$;",
  ],
  [
    'a column grant two quotes deep',
    "do $o$ begin execute $i$ select 'grant update (a) on s.t to r' $i$; end $o$;",
  ],
  [
    'a column list from format',
    "do $$ begin execute format('grant update (%s) on s.t to r', 'a'); end $$;",
  ],
  [
    'a privilege from format',
    "do $$ begin execute format('grant %s on s.t to r', 'update (a)'); end $$;",
  ],
  [
    'a grantee from format with %s',
    "do $$ begin execute format('grant x on s.t to %s', 'r; grant update (a) on s.t to r'); end $$;",
  ],
  [
    'a grant cut short for a concatenation',
    "do $$ begin execute 'grant update ' || '(a) on s.t to r'; end $$;",
  ],
];

describe('reading a column grant the way PostgreSQL does', () => {
  it.each(READS)('reads %s', (_, sql, lines) => {
    expect(read(sql)).toStrictEqual(lines);
  });

  it.each(REFUSALS)('refuses %s', (_, sql) => {
    expect(() => read(sql)).toThrow(/statement 1/u);
  });
});
