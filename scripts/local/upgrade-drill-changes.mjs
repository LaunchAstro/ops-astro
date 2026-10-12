// SPDX-License-Identifier: AGPL-3.0-only
//
// The upgrade drill's declared changes (`upgrade-drill.mjs`): a migration that
// changes existing rows on purpose lists them in `migrations/<version>.changes.json`,
// beside itself, as `{ table, columns, where }`. This module reads those lists,
// picks each one's rows just before its migration, and compares the snapshots
// either side of that migration with them: a changed row is excused only where
// a declaration of that migration picked it and the row after differs from it in
// that declaration's columns alone. So a declaration answers for its own
// migration and no other, and two declared migrations may change one row in
// turn. A declaration that excuses no row fails the drill: the change it names
// did not happen, and an unused declaration would be a standing hole in the
// check.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

const NAME = /^[a-z_][a-z0-9_]*$/u;

/**
 * The declarations of the migrations an upgrade applies, each checked against
 * the snapshot before it: a table and columns it holds, and a predicate.
 */
export function readDeclarations(directory, applying, before, Refused) {
  const declarations = [];
  for (const { version } of applying) {
    const file = join(directory, `${version}.changes.json`);
    if (!existsSync(file)) continue;
    const refuse = (why) => {
      throw new Refused(`${version}.changes.json: ${why}`);
    };
    let list;
    try {
      list = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      refuse('not JSON');
    }
    if (!Array.isArray(list) || list.length === 0) refuse('not a list of changes');
    for (const one of list) {
      const [schema, relname, extra] = String(one?.table ?? '').split('.');
      if (extra !== undefined || !NAME.test(schema ?? '') || !NAME.test(relname ?? ''))
        refuse('a table is not schema.name');
      const held = before.get(one.table)?.columns;
      if (held === undefined) refuse(`no table ${one.table} before the upgrade`);
      if (!Array.isArray(one.columns) || one.columns.length === 0)
        refuse(`no columns for ${one.table}`);
      for (const column of one.columns) {
        if (typeof column !== 'string' || !held.includes(column))
          refuse(`${one.table} has no column ${String(column)} before the upgrade`);
      }
      if (typeof one.where !== 'string' || one.where.trim() === '')
        refuse(`no row predicate for ${one.table}`);
      declarations.push({
        migration: version,
        table: one.table,
        schema,
        relname,
        columns: one.columns,
        where: one.where,
      });
    }
  }
  return declarations;
}

/**
 * The rows each declaration's predicate picks now, just before its migration,
 * in the snapshot's form: the columns the table had before the upgrade. A
 * predicate is a migration's own SQL, read as the owner, so it is read in a
 * read-only transaction one command at a time: a predicate that smuggled in a
 * write or a second statement is refused, never run.
 */
export async function declaredRows(admin, declarations, before) {
  for (const declaration of declarations) {
    // oxlint-disable-next-line no-await-in-loop
    const rows = await admin.transaction(
      async (execute) => {
        await execute('set transaction read only');
        return await execute(
          `select (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(t))
                    where key = any($1::text[]))::text as row
             from ${quote(declaration.schema)}.${quote(declaration.relname)} t
            where (${declaration.where})`,
          [before.get(declaration.table).columns],
        );
      },
      { oneCommandEach: true },
    );
    declaration.picks = new Map();
    for (const { row } of rows) declaration.picks.set(row, (declaration.picks.get(row) ?? 0) + 1);
    declaration.rows = 0;
  }
}

/** A row's text without the given columns, comparable between two rows of one table. */
const without = (row, columns) => {
  const value = JSON.parse(row);
  for (const column of columns) delete value[column];
  return JSON.stringify(value);
};

/**
 * The unmatched later row that a declaration of this table, having picked this
 * earlier row, explains as differing from it in that declaration's columns
 * alone; it is taken, so it excuses one earlier row only.
 */
function excuse(row, unmatched, declarations) {
  for (const declaration of declarations) {
    if ((declaration.picks.get(row) ?? 0) === 0) continue;
    const want = without(row, declaration.columns);
    const at = unmatched.findIndex((later) => without(later, declaration.columns) === want);
    if (at === -1) continue;
    declaration.picks.set(row, declaration.picks.get(row) - 1);
    declaration.rows += 1;
    return unmatched.splice(at, 1)[0];
  }
  return null;
}

/** A table's difference, added to the one already reported for it if there is one. */
function report(differences, difference) {
  const seen = differences.find((one) => one.table === difference.table);
  if (seen === undefined) {
    differences.push(difference);
    return;
  }
  seen.changedOrLost += difference.changedOrLost;
  seen.gone ||= difference.gone;
}

/**
 * The migrations after `at` cut into runs, each applied and compared on its
 * own: a migration that declares a change alone, with its declarations, and
 * the migrations between two such together, with none. A run ends before
 * `all[through]`.
 */
export function runsOf(all, at, declarations) {
  const runs = [];
  for (let through = at + 2; through <= all.length; through += 1) {
    const mine = declarations.filter((one) => one.migration === all[through - 1].version);
    const last = runs.at(-1);
    if (mine.length === 0 && last?.declarations.length === 0) last.through = through;
    else runs.push({ through, declarations: mine });
  }
  return runs;
}

/**
 * Each table whose kept rows are not all still there, unchanged or changed as
 * declared, reported into `differences`, and the kept rows as they now stand.
 * The rows kept are those there before the upgrade, each as the last declared
 * change left it; a row a migration added is not kept, so a later migration
 * may change it.
 */
export function compare(kept, after, declarations = [], differences = []) {
  const next = new Map();
  for (const [table, { rows }] of kept) {
    const now = after.get(table);
    if (now === undefined) {
      report(differences, { table, changedOrLost: rows.length, added: 0, gone: true });
      continue;
    }
    const waiting = new Map();
    for (const row of rows) waiting.set(row, (waiting.get(row) ?? 0) + 1);
    const unmatched = [];
    const still = [];
    for (const row of now.rows) {
      const count = waiting.get(row) ?? 0;
      if (count === 0) {
        unmatched.push(row);
        continue;
      }
      waiting.set(row, count - 1);
      still.push(row);
    }
    const mine = declarations.filter((declaration) => declaration.table === table);
    let changedOrLost = 0;
    for (const [row, count] of waiting) {
      for (let n = 0; n < count; n += 1) {
        const later = excuse(row, unmatched, mine);
        if (later === null) changedOrLost += 1;
        else still.push(later);
      }
    }
    next.set(table, { rows: still });
    if (changedOrLost > 0)
      report(differences, { table, changedOrLost, added: unmatched.length, gone: false });
  }
  return next;
}

/** What the result says of each declaration. */
export const declaredOf = (declarations) =>
  declarations.map(({ migration, table, columns, rows }) => ({ migration, table, columns, rows }));

/** One line per declaration: how many rows it excused, or that its change did not happen. */
export const declaredReport = (declared) =>
  declared.map((d) =>
    d.rows === 0
      ? `${d.migration}: declared change to ${d.table} did not happen`
      : `${d.migration}: ${d.table}, ${d.rows} declared row${d.rows === 1 ? '' : 's'} changed (${d.columns.join(', ')})`,
  );
