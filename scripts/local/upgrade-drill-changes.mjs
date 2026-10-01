// SPDX-License-Identifier: AGPL-3.0-only
//
// The upgrade drill's declared changes (`upgrade-drill.mjs`): a migration that
// changes existing rows on purpose lists them in `migrations/<version>.changes.json`,
// beside itself, as `{ table, columns, where }`. This module reads those lists,
// picks each one's rows before the upgrade, and compares the snapshots with them:
// a changed row is excused only where a declaration of a migration this upgrade
// applied picked it, read before the upgrade, and the row after differs from it
// in that declaration's columns alone. A declaration that excuses no row fails
// the drill: the change it names did not happen, and an unused declaration would
// be a standing hole in the check.

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
 * The rows each declaration's predicate picks before the upgrade, in the
 * snapshot's form. A predicate is a migration's own SQL, read as the owner, so
 * it is read in a read-only transaction one command at a time: a predicate that
 * smuggled in a write or a second statement is refused, never run.
 */
export async function declaredRows(admin, declarations) {
  for (const declaration of declarations) {
    // oxlint-disable-next-line no-await-in-loop
    const rows = await admin.transaction(
      async (execute) => {
        await execute('set transaction read only');
        return await execute(
          `select to_jsonb(t)::text as row from ${quote(declaration.schema)}.${quote(declaration.relname)} t
            where (${declaration.where})`,
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
 * Whether a declaration of this table picked this earlier row and an unmatched
 * later row differs from it in that declaration's columns alone; that later
 * row is then taken, so it excuses one earlier row only.
 */
function excuse(row, unmatched, declarations) {
  for (const declaration of declarations) {
    if ((declaration.picks.get(row) ?? 0) === 0) continue;
    const want = without(row, declaration.columns);
    const at = unmatched.findIndex((later) => without(later, declaration.columns) === want);
    if (at === -1) continue;
    unmatched.splice(at, 1);
    declaration.picks.set(row, declaration.picks.get(row) - 1);
    declaration.rows += 1;
    return true;
  }
  return false;
}

/** Each table whose earlier rows are not all still there, unchanged or changed as declared. */
export function compare(before, after, declarations = []) {
  const differences = [];
  for (const [table, { rows }] of before) {
    const now = after.get(table);
    if (now === undefined) {
      differences.push({ table, changedOrLost: rows.length, added: 0, gone: true });
      continue;
    }
    const waiting = new Map();
    for (const row of rows) waiting.set(row, (waiting.get(row) ?? 0) + 1);
    const unmatched = [];
    for (const row of now.rows) {
      const count = waiting.get(row) ?? 0;
      if (count > 0) waiting.set(row, count - 1);
      else unmatched.push(row);
    }
    const mine = declarations.filter((declaration) => declaration.table === table);
    let changedOrLost = 0;
    for (const [row, count] of waiting) {
      for (let n = 0; n < count; n += 1) {
        if (!excuse(row, unmatched, mine)) changedOrLost += 1;
      }
    }
    if (changedOrLost > 0)
      differences.push({ table, changedOrLost, added: unmatched.length, gone: false });
  }
  return differences;
}

/** One line per declaration: how many rows it excused, or that its change did not happen. */
export const declaredReport = (declared) =>
  declared.map((d) =>
    d.rows === 0
      ? `${d.migration}: declared change to ${d.table} did not happen`
      : `${d.migration}: ${d.table}, ${d.rows} declared row${d.rows === 1 ? '' : 's'} changed (${d.columns.join(', ')})`,
  );
