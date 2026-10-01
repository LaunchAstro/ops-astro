// SPDX-License-Identifier: AGPL-3.0-only
//
// The manual privacy runbook's copy finder (C81, docs/local/PRIVACY-RUNBOOK.md):
// every row of one business that holds a person's text, in any table, in any
// letter case, including the records' search column, and every row naming a
// person whose own row holds it by id (their memberships). It reads with the
// owner's connection from DATABASE_ADMIN_URL, with row security off, so a table
// the connection cannot read in full is an error rather than a silent gap. Every
// query names the business, and a table with no business column is an error,
// so no other business's row reaches the list or the export.
//
//   node scripts/privacy/find-copies.mjs --business <key> \
//     --text <what names the person> [--export]
//
// Each hit is one JSON line: the table, the row's id (or its physical address
// when the table has no id) and the columns holding the text. The row itself
// is printed only with --export, for the request's file; the list alone never
// spreads the person's details further. The connection string is never
// printed.

import { argv, env, exit, stderr, stdout } from 'node:process';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';

const SAFE = /^[a-z_][a-z0-9_]{0,62}$/u;

function parse(args) {
  let text;
  let business;
  let exportRows = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--export') exportRows = true;
    else if (arg === '--text') {
      index += 1;
      text = args[index];
    } else if (arg === '--business') {
      index += 1;
      business = args[index];
    } else return { error: `unknown argument ${JSON.stringify(arg)}` };
  }
  if (typeof text !== 'string' || text.trim().length < 4) {
    return { error: '--text needs at least 4 characters that name the person' };
  }
  if (typeof business !== 'string' || business === '') {
    return { error: '--business needs the key of the business the request is for' };
  }
  return { text, business, exportRows };
}

/** The text as a LIKE pattern matching itself alone, wherever it appears. */
function containing(text) {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/**
 * The business's rows holding the needle, one JSON line each; answers how
 * many, or null when no business has the key.
 */
async function scan(admin, business, needle, exportRows) {
  let hits = null;
  await admin.transaction(async (execute) => {
    await execute('set transaction read only');
    await execute('set local row_security = off');
    const [owner] = await execute(`select id from public.businesses where key = $1`, [business]);
    if (owner === undefined) return;
    hits = 0;
    // A row naming the person by id alone (a membership) is a copy of them too.
    const people = await execute(
      `select t.id::text as id from public.people t
        where t.business_id = $2 and lower(to_jsonb(t)::text) like $1`,
      [containing(needle), owner.id],
    );
    const ids = people.map((person) => person.id);
    const tables = await execute(
      `select c.relname as name,
              exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'business_id'
                         and not a.attisdropped) as scoped
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by c.relname`,
    );
    for (const { name, scoped } of tables) {
      if (!SAFE.test(name)) throw new Error(`find-copies: unexpected table name ${name}`);
      if (!scoped) throw new Error(`find-copies: table ${name} has no business_id`);
      // oxlint-disable-next-line no-await-in-loop
      const rows = await execute(
        `select t.ctid::text as address, to_jsonb(t) as row from public."${name}" t
          where t.business_id = $2
            and (lower(to_jsonb(t)::text) like $1 or to_jsonb(t)::text like any($3::text[]))`,
        [containing(needle), owner.id, ids.map((id) => `%${id}%`)],
      );
      for (const { address, row } of rows) {
        const columns = Object.keys(row).filter((column) => {
          const held = JSON.stringify(row[column]).toLowerCase();
          return held.includes(needle) || ids.some((id) => held.includes(id));
        });
        const found = { table: name, id: row.id ?? address, columns };
        if (exportRows) found.row = row;
        stdout.write(`${JSON.stringify(found)}\n`);
        hits += 1;
      }
    }
  });
  return hits;
}

async function main() {
  const options = parse(argv.slice(2));
  if ('error' in options) {
    stderr.write(`find-copies: ${options.error}\n`);
    return 2;
  }
  const url = env.DATABASE_ADMIN_URL;
  if (url === undefined || url === '') {
    stderr.write('find-copies: DATABASE_ADMIN_URL is unset\n');
    return 2;
  }
  const admin = connectAsAdmin(url, { source: 'privacy-find-copies' });
  // Rows are searched in their JSON form, so the text is escaped the same way
  // (a quote or backslash in a name is found as the row holds it).
  const needle = JSON.stringify(options.text.toLowerCase()).slice(1, -1);
  let hits = null;
  try {
    hits = await scan(admin, options.business, needle, options.exportRows);
  } finally {
    await admin.close();
  }
  if (hits === null) {
    stderr.write(`find-copies: no business has the key ${JSON.stringify(options.business)}\n`);
    return 2;
  }
  stderr.write(`find-copies: ${String(hits)} row(s) hold the text\n`);
  return 0;
}

exit(await main());
