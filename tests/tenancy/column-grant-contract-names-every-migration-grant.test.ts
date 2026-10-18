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
import { columnGrants, migrationColumnGrants } from './migration-column-grants.ts';
import { columnUpdatesAt, roleColumnGrantsAt } from './restricted-calls-catalogue.ts';

const migrations = readMigrations(new URL('../../migrations', import.meta.url).pathname);
const contract = new Set([
  ...columnUpdatesAt().map((pair) => `${APPLICATION_ROLE} UPDATE ${pair}`),
  ...roleColumnGrantsAt(),
]);
const read = (sql: string): string[] => columnGrants(splitStatements(sql));

describe('the column-grant contract, against the migrations', () => {
  it('names every column grant a migration makes', () => {
    const found = migrations.flatMap((migration) => migrationColumnGrants(migration));
    // Non-vacuous: the reader finds the grants the contract was written from.
    expect(found).toContain('ops_astro_lookup SELECT public.businesses.key');
    expect(found).toContain(`${APPLICATION_ROLE} UPDATE public.leases.state`);
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter((line) => !contract.has(line))).toStrictEqual([]);
  });

  it('fails on a new migration whose column grants the contract does not name', () => {
    const planted = [
      ...migrations,
      {
        version: '20261018033724_planted',
        statements: [
          'grant select (message_digest), insert (message_digest) on ops.auth_hook_messages to ops_astro_app',
        ],
      },
    ];
    const found = planted.flatMap((migration) => migrationColumnGrants(migration));
    expect(found.filter((line) => !contract.has(line))).toStrictEqual([
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
  ['an EXECUTE of a literal with USING', "do $$ begin execute 'select $1' using 1; end $$;", []],
  [
    'format with %I and %%',
    "do $$ begin execute format('grant r to %I -- 100%%', current_user); end $$;",
    [],
  ],
  [
    'a set_config() of one literal setting',
    "do $$ begin perform set_config('app.business_id', 'x', true); end $$;",
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
  [
    'an octal escape in an E string',
    String.raw`do $$ begin execute E'\147rant update (a) on s.t to r'; end $$;`,
  ],
  ['a U& escape', String.raw`do $$ begin execute U&'\0067rant update (a) on s.t to r'; end $$;`],
  [
    'a U& escape with UESCAPE',
    "do $$ begin execute U&'!0067rant update (a) on s.t to r' uescape '!'; end $$;",
  ],
  [
    'an escape across a string continuation',
    "do $$ begin execute E'\\x67'\n'rant update (a) on s.t to r'; end $$;",
  ],
  [
    'a keyword split across a concatenation',
    "do $$ begin execute 'gr' || 'ant update (a) on s.t to r'; end $$;",
  ],
  [
    'SQL decoded at run time',
    "do $$ begin execute convert_from(decode('6772616e74', 'hex'), 'utf8'); end $$;",
  ],
  ['SQL held in a variable', 'do $$ declare q text; begin execute q; end $$;'],
  ['a format() with %L', "do $$ begin execute format('select %L', 'x'); end $$;"],
  ['a body in another language', "do language plpython3u $$ plpy.execute('select 1') $$;"],
  [
    'an escape in a string that grants nothing',
    String.raw`do $$ begin raise notice E'\x67o\n'; end $$;`,
  ],
  ['an escaped quote in an E string', String.raw`select E'it\'s';`],
  ['a literal backslash in an E string', String.raw`select strpos(x, E'\\') from s.t;`],
  ['a U& escape in a string that grants nothing', String.raw`select U&'\0067o';`],
  ['standard_conforming_strings turned off', 'set standard_conforming_strings = off;'],
  [
    'standard_conforming_strings set from a string',
    "select set_config('standard_conforming_strings', 'off', false);",
  ],
  [
    'standard_conforming_strings as a quoted name',
    'alter role r set "Standard_Conforming_Strings" = off;',
  ],
  [
    'standard_conforming_strings in a function body',
    'create function s.f() returns void language sql set standard_conforming_strings = off as $$ select 1 $$;',
  ],
  [
    'a set_config() setting joined at run time',
    "select set_config('standard_' || 'conforming_strings', 'off', false);",
  ],
  [
    'a set_config() setting by named argument',
    "select pg_catalog.set_config(new_value => 'off', setting_name => 's', is_local => false);",
  ],
  ['a set_config() called by a quoted name', 'select "set_config"(n, \'off\', false) from s.t;'],
  [
    'an update of pg_settings',
    "update pg_settings set setting = 'off' where name like 'standard%';",
  ],
  ['a client encoding set', "set client_encoding = 'SJIS';"],
  ['a client encoding set with SET NAMES', "set session names 'SJIS';"],
  [
    'a column list behind a quote in a comment between string parts',
    "do $$ begin execute 'grant select ' -- 'on s.t to r\n'(a) on s.t to r'; end $$;",
  ],
  [
    'a setting name joined across a comment holding a quote',
    "select set_config('standard_conforming' -- '\n'_strings', 'off', false);",
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

describe('format() placeholders that carry any SQL', () => {
  const revoke = "do $$ begin execute format('revoke %s from %s', 'a', 'b'); end $$;";

  it('are read only in the migration named as read by hand', () => {
    const version = '20261004102910_identity_roles_hold_no_membership';
    expect(migrationColumnGrants({ version, statements: splitStatements(revoke) })).toStrictEqual(
      [],
    );
  });

  it('are refused in any other migration', () => {
    const version = '20261018000000_another';
    expect(() => migrationColumnGrants({ version, statements: splitStatements(revoke) })).toThrow(
      /placeholder %s/u,
    );
  });
});

describe('a literal backslash in an E string', () => {
  const check = String.raw`alter table s.t add constraint c check (strpos(x, E'\\') = 0);`;

  it('is read only in the migration named as read by hand', () => {
    const version = '0094_conversation_page_scope';
    expect(migrationColumnGrants({ version, statements: splitStatements(check) })).toStrictEqual(
      [],
    );
  });

  it('is refused in any other migration', () => {
    const version = '20261018000000_another';
    expect(() => migrationColumnGrants({ version, statements: splitStatements(check) })).toThrow(
      /string escape/u,
    );
  });

  it('is refused in the migration read by hand when it hides another escape', () => {
    const version = '0094_conversation_page_scope';
    const hex = String.raw`do $$ begin execute E'\\\x67rant update (a) on s.t to r'; end $$;`;
    expect(() => migrationColumnGrants({ version, statements: splitStatements(hex) })).toThrow(
      /string escape/u,
    );
  });
});
