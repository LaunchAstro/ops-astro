// SPDX-License-Identifier: AGPL-3.0-only
//
// The tenancy conformance set, and the composite-key migration linter inside
// it. Both read the catalogue of a database migrated from empty rather than
// the text of the migration files.
//
// Reading the catalogue is the whole point. A linter that reads SQL text can
// be fooled by a line break, by a constraint added in a later migration, and
// by anything written in a shape it did not anticipate; and it cannot see what
// the server actually did with what it was given. The catalogue is what the
// server built. If a rule holds there, it holds.
//
// Each check returns findings rather than throwing, so one run reports every
// violation instead of the first one.

import type { AdminConnection } from './database.ts';

export interface Finding {
  /** The rule that failed, in the words the law is written in. */
  readonly rule: string;
  /** What failed it: a table, a constraint, a policy. */
  readonly object: string;
  readonly detail: string;
}

type Read = AdminConnection['execute'];

/** The session setting the tenancy policy must read, and nothing else. */
export const TENANCY_PREDICATE = '(business_id = (select app_business_id() as app_business_id))';

function normalise(expression: string): string {
  return expression
    .toLowerCase()
    .replaceAll(/\s+/gu, ' ')
    .replaceAll('( ', '(')
    .replaceAll(' )', ')')
    .trim();
}

interface TableRow {
  readonly relname: string;
  readonly relrowsecurity: boolean;
  readonly relforcerowsecurity: boolean;
}

interface ColumnRow {
  readonly table_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
}

interface PolicyRow {
  readonly tablename: string;
  readonly policyname: string;
  readonly permissive: string;
  readonly cmd: string;
  readonly qual: string | null;
  readonly with_check: string | null;
}

interface IndexRow {
  readonly tablename: string;
  readonly indexname: string;
  readonly columns: readonly string[];
  readonly is_unique: boolean;
}

interface ForeignKeyRow {
  readonly conname: string;
  readonly child: string;
  readonly parent: string;
  readonly child_columns: readonly string[];
  readonly parent_columns: readonly string[];
}

/** Every regular table in `public`. Installation bookkeeping lives in `ops`. */
async function applicationTables(read: Read): Promise<readonly TableRow[]> {
  return await read<TableRow>(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`,
  );
}

async function indexes(read: Read): Promise<readonly IndexRow[]> {
  return await read<IndexRow>(
    `select t.relname as tablename,
            i.relname as indexname,
            x.indisunique as is_unique,
            (select array_agg(a.attname order by k.ord)
               from unnest(x.indkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum) as columns
       from pg_index x
       join pg_class i on i.oid = x.indexrelid
       join pg_class t on t.oid = x.indrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relkind = 'r'`,
  );
}

async function foreignKeys(read: Read): Promise<readonly ForeignKeyRow[]> {
  return await read<ForeignKeyRow>(
    `select c.conname,
            child.relname as child,
            parent.relname as parent,
            (select array_agg(a.attname order by k.ord)
               from unnest(c.conkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = child.oid and a.attnum = k.attnum) as child_columns,
            (select array_agg(a.attname order by k.ord)
               from unnest(c.confkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = parent.oid and a.attnum = k.attnum) as parent_columns
       from pg_constraint c
       join pg_class child on child.oid = c.conrelid
       join pg_class parent on parent.oid = c.confrelid
       join pg_namespace n on n.oid = child.relnamespace
      where c.contype = 'f' and n.nspname = 'public'`,
  );
}

/**
 * The migration linter. Every foreign key between application tables is
 * `(business_id, parent_id) references parent(business_id, id)`, because a
 * referential-integrity check bypasses row security: a single-column key lets
 * a row in one business reference a parent in another, and the tenancy policy
 * then hides that parent, leaving a corrupt relationship that leaks by
 * inference.
 */
export async function lintCompositeKeys(read: Read): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const keys = await foreignKeys(read);
  const unique = (await indexes(read)).filter((index) => index.is_unique);

  for (const key of keys) {
    const where = `${key.child}.${key.conname}`;
    if (key.child_columns.length < 2) {
      findings.push({
        rule: 'no single-column cross-table foreign key',
        object: where,
        detail: `references ${key.parent} on (${key.child_columns.join(', ')})`,
      });
      continue;
    }
    if (key.child_columns[0] !== 'business_id' || key.parent_columns[0] !== 'business_id') {
      findings.push({
        rule: 'a composite foreign key leads with business_id on both sides',
        object: where,
        detail: `(${key.child_columns.join(', ')}) references ${key.parent}(${key.parent_columns.join(', ')})`,
      });
    }
    const parentKey = unique.find(
      (index) =>
        index.tablename === key.parent &&
        index.columns.length === key.parent_columns.length &&
        index.columns.every((column, at) => column === key.parent_columns[at]),
    );
    if (parentKey === undefined) {
      findings.push({
        rule: 'every composite-key parent is unique on the referenced columns',
        object: key.parent,
        detail: `no unique index on (${key.parent_columns.join(', ')}), required by ${where}`,
      });
    }
  }
  return findings;
}

/**
 * The tenancy conformance set. Every application table carries `business_id`
 * not null and indexed, row security is enabled and forced, there is exactly
 * one restrictive policy and it reads the session setting, policies carry no
 * joins, and every cross-table key is composite.
 */
export async function tenancyConformance(read: Read): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const tables = await applicationTables(read);
  if (tables.length === 0) {
    return [
      {
        rule: 'the conformance set reads a migrated database',
        object: 'public',
        detail: 'no application table exists, so nothing was checked',
      },
    ];
  }

  const columns = await read<ColumnRow>(
    `select table_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public' and column_name = 'business_id'`,
  );
  const policies = await read<PolicyRow>(
    `select tablename, policyname, permissive, cmd, qual, with_check
       from pg_policies where schemaname = 'public'`,
  );
  const allIndexes = await indexes(read);

  for (const table of tables) {
    const column = columns.find((each) => each.table_name === table.relname);
    if (column === undefined) {
      findings.push({
        rule: 'business_id uuid not null on every application table',
        object: table.relname,
        detail: 'no business_id column',
      });
    } else if (column.data_type !== 'uuid' || column.is_nullable !== 'NO') {
      findings.push({
        rule: 'business_id uuid not null on every application table',
        object: table.relname,
        detail: `business_id is ${column.data_type}, nullable ${column.is_nullable}`,
      });
    }

    const indexed = allIndexes.some(
      (index) => index.tablename === table.relname && index.columns[0] === 'business_id',
    );
    if (!indexed) {
      findings.push({
        rule: 'business_id is indexed on every application table',
        object: table.relname,
        detail: 'no index leads with business_id',
      });
    }

    if (!table.relrowsecurity || !table.relforcerowsecurity) {
      findings.push({
        rule: 'row security enabled and forced on every application table',
        object: table.relname,
        detail: `enabled ${table.relrowsecurity}, forced ${table.relforcerowsecurity}`,
      });
    }

    const own = policies.filter((policy) => policy.tablename === table.relname);
    const restrictive = own.filter((policy) => policy.permissive === 'RESTRICTIVE');
    if (restrictive.length !== 1) {
      findings.push({
        rule: 'exactly one restrictive tenancy policy per table',
        object: table.relname,
        detail: `${restrictive.length} restrictive policies: ${restrictive.map((p) => p.policyname).join(', ') || 'none'}`,
      });
    }
    for (const policy of restrictive) {
      for (const [what, expression] of [
        ['using', policy.qual],
        ['with check', policy.with_check],
      ] as const) {
        if (expression === null || normalise(expression) !== TENANCY_PREDICATE) {
          findings.push({
            rule: 'the tenancy policy reads the session setting and nothing else',
            object: `${table.relname}.${policy.policyname}`,
            detail: `${what} is ${expression ?? 'absent'}, expected ${TENANCY_PREDICATE}`,
          });
        }
      }
      if (policy.cmd !== 'ALL') {
        findings.push({
          rule: 'the tenancy policy covers every command',
          object: `${table.relname}.${policy.policyname}`,
          detail: `covers ${policy.cmd}`,
        });
      }
    }

    // A table with row security on and no permissive policy shows nothing to
    // anyone. That is a closed table, not a tenanted one, and it fails in a way
    // that looks like an empty database rather than a refusal.
    if (!own.some((policy) => policy.permissive === 'PERMISSIVE')) {
      findings.push({
        rule: 'a restrictive policy needs a permissive one to restrict',
        object: table.relname,
        detail: 'row security is on and no permissive policy exists',
      });
    }

    for (const policy of own) {
      for (const expression of [policy.qual, policy.with_check]) {
        if (expression === null) continue;
        const rest = normalise(expression).replaceAll(
          '(select app_business_id() as app_business_id)',
          '',
        );
        if (/\bjoin\b|\bfrom\b/u.test(rest)) {
          findings.push({
            rule: 'policies carry no joins',
            object: `${table.relname}.${policy.policyname}`,
            detail: expression,
          });
        }
      }
    }
  }

  findings.push(...(await lintCompositeKeys(read)));
  return findings;
}

export function describeFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  ${f.rule}\n    ${f.object}: ${f.detail}`).join('\n');
}
