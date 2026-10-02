// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5's effect proof, its one measure: each table's rows digested before and
// after a command, and the tables it changed that its entry does not declare.
// Shared by the catalogue's pass over its positive fixtures
// (`s0-5-effect-metadata.test.ts`) and the paths those fixtures miss
// (SEC3BFINAL, `s0-5-effect-money-paths.test.ts`). A helper, not a suite.

import { COMMAND_EFFECTS, type CommandName } from '../../packages/core-wire/src/index.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

type Admin = Pick<AdminConnection, 'execute'>;

/**
 * Written for every call as the record of the act, never a record kind of its
 * own: the audit event, the operation row, the bearer's verification, and the
 * live change record (0065, C4), stamped by a task write's own triggers with
 * only which task and the writing transaction.
 */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
  'live_changes',
]);

/**
 * Each table's rows as one digest, read past row security on the owner's
 * connection: a public table under its own name, an installation table in
 * `ops` as `ops.<name>` (the migration ledger aside).
 */
export async function fingerprint(admin: Admin): Promise<ReadonlyMap<string, string>> {
  const tables = await admin.execute<{ readonly name: string }>(
    `select case n.nspname when 'public' then c.relname else 'ops.' || c.relname end as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'ops') and c.relkind in ('r', 'p')
        and (n.nspname, c.relname) <> ('ops', 'schema_migrations')
      order by 1`,
  );
  const union = tables
    .map(
      ({ name }) =>
        `select '${name}' as name, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from ${name.includes('.') ? name : `public.${name}`} t`,
    )
    .join(' union all ');
  const rows = await admin.execute<{ name: string; digest: string }>(union);
  return new Map(rows.map((row) => [row.name, row.digest]));
}

/** The tables whose rows changed between two fingerprints, the act's bookkeeping aside. */
export function changed(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...after.keys()].filter(
    (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
  );
}

/** Each of `written` that `name`'s entry does not declare, as the proof names it. */
export function undeclared(name: CommandName, written: readonly string[]): string[] {
  const declared = COMMAND_EFFECTS[name].writes;
  return written
    .filter((table) => !declared.some((kind) => kind.kind === table))
    .map((table) => `${name}: wrote ${table}, undeclared`);
}

/**
 * A path a command's positive fixture misses. `prepare` builds its world and
 * answers the act; the act must answer `code`, write each of `drives` (so the
 * path was really reached) and write nothing its entry does not declare.
 */
export interface EffectPath {
  readonly name: CommandName;
  readonly code: string;
  readonly drives: readonly string[];
  prepare(): Promise<() => Promise<string>>;
}

/** What is wrong with `path`'s writes: none when it is declared whole. */
export async function pathFaults(admin: Admin, path: EffectPath): Promise<string[]> {
  const act = await path.prepare();
  const before = await fingerprint(admin);
  const code = await act();
  if (code !== path.code) return [`${path.name}: answered ${code}, not ${path.code}`];
  const written = changed(before, await fingerprint(admin));
  return [
    ...path.drives
      .filter((table) => !written.includes(table))
      .map((table) => `${path.name}: its path did not write ${table}`),
    ...undeclared(path.name, written),
  ];
}
