// SPDX-License-Identifier: AGPL-3.0-only
//
// The manual privacy runbook's copy finder (C81, docs/local/PRIVACY-RUNBOOK.md,
// 'Every copy of a person'): every row of one business that holds a request's
// text or an id of the people it names.
//
//   node scripts/privacy/find-copies.mjs --business <key> \
//     [--text <what names the person>] [--id <uuid>]... [--export]
//
// The people are seeded from the business's own rows: a person whose name, or
// an identifier not rejected, holds the text as whole words (Anna names no
// Joanna), anyone a merge not reversed joined them to, and each --id as given.
// Their ids follow to their actors, the logins they still hold, each
// delegation acting for them, and the agent of each credential they issued or
// delegation acting for them, with the logins it still holds. An agent that a
// credential or delegation of anyone outside the person's merges names too is
// shared, given with --id or not, as is a login given that is or was linked to
// an agent not standing for the given ids, unless their own agent or person
// holds it now: a shared id stands for no one, and a row holding it is listed
// for the owner to judge. A row is a
// copy when one of its values, at any depth, holds the text anywhere, the
// stored name of one of those people as whole words (when it has four letters
// or digits, as the text needs), or one of those ids in any letter case; a
// column's or a JSON field's name never counts ("granted_at" names no Grant).
// Letters are folded by the database, and each run of white space is one
// space, so the text is matched as the database's locale cases it.
//
// One read-only snapshot answers every query, with the owner's connection from
// DATABASE_ADMIN_URL and row security off, so a row committed mid-search is in
// all of the list or none of it, and a table the connection cannot read in
// full is an error rather than a silent gap. Every query names the business;
// a table with no business column, a materialised view and a foreign table
// are errors.
//
// Each hit is one JSON line: the table, the row's id (or its physical address
// when the table has no id), the columns holding the text, a name or an id,
// the people whose ids it holds, the shared ids it holds, whether it holds the
// text or a stored name, and whether it holds an id given with --id (never a
// shared id). The row itself is printed
// only with --export, credential hashes withheld. The summary on stderr ends
// with a line per person, saying every way they were found, of the --id flags
// that find them after their own rows are erased, then a line per shared
// id. The list is printed once
// the search has finished; the connection string is never printed. The
// command line is read in find-copies-arguments.mjs.

import process from 'node:process';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { WHITE, namesSomeone, parse } from './find-copies-arguments.mjs';
import { SEEDS, STORED_NAMES } from './find-copies-seeds.mjs';

const { argv, env, stderr, stdout } = process;
const SAFE = /^[a-z_][a-z0-9_]{0,62}$/u;
/** `WHITE` as a Postgres bracket expression, each by its code point. */
const WHITE_RUN = `[${[...WHITE].map((character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`).join('')}]+`;

/** Columns an export never carries: the business's security material, not the person's data. */
const WITHHELD = new Map([
  ['agent_credentials', ['credential_hash']],
  ['delegations', ['credential_hash']],
]);

/** A failure the operator is told about in words; any other is reported without its detail. */
class Refusal extends Error {}

/** The text as a LIKE pattern matching itself alone, wherever it appears. */
function containing(text) {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/** `text` folded, with each run of white space as one space, as `spaced` does here. */
const folded = (text) => `regexp_replace(lower(${text}), '${WHITE_RUN}', ' ', 'g')`;

/** Each value held at any depth of `json`, folded, as `held`; never a field's name. */
const values = (json) => `(select ${folded("v #>> '{}'")} as held
      from jsonb_path_query(${json}, 'strict $.**') v
     where jsonb_typeof(v) not in ('object', 'array', 'null')) s`;

/** Whether `s.held` holds the text ($1, or null) or a stored name's words ($6) in order. */
const TEXT = `(s.held like lower($1::text)
      or cardinality($6::tsquery[]) > 0 and to_tsvector('simple', s.held) @@ any($6::tsquery[]))`;

/** Whether `s.held` holds the text ($1, or null), a stored name ($6), a seed id ($3) or a shared agent's ($7). */
const HOLDS = `(${TEXT} or exists (select from unnest($3::text[] || $7::text[]) i where strpos(s.held, i) > 0))`;

/**
 * Rows of business $2 holding the text, a stored name ($6), a seed ($3,
 * standing for people $4; $5 the given ids) or a shared agent's id ($7). The table is read first, so the statement's opening
 * names it, as a lock wait shows it in pg_stat_activity.
 */
const copies = (table) => `with r as (
      select t.ctid as address, to_jsonb(t) as row
        from public."${table}" t
       where t.business_id = $2)
  select r.address::text as address, r.row,
      array(select c.key from jsonb_each(r.row) c
             where exists (select from ${values('c.value')} where ${HOLDS})
             order by c.key) as columns,
      array(select distinct seed.person from unnest($3::text[], $4::text[]) seed(id, person)
             where exists (select from ${values('r.row')} where strpos(s.held, seed.id) > 0)
             order by 1) as people,
      array(select g from unnest($7::text[]) g
             where exists (select from ${values('r.row')} where strpos(s.held, g) > 0)
             order by 1) as shared,
      exists (select from ${values('r.row')} where ${TEXT}) as text,
      exists (select from ${values('r.row')}
               where exists (select from unnest($5::text[]) g where strpos(s.held, g) > 0)) as given
    from r
   where exists (select from ${values('r.row')} where ${HOLDS})
   order by r.address`;

/** The public schema's tables, materialised views and foreign tables, never a partition. */
const TABLES = `select c.relname as name, c.relkind as kind,
              exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'business_id'
                         and not a.attisdropped) as scoped
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'm', 'f') and not c.relispartition
        order by c.relname`;

/** The row as an export carries it, with the table's withheld columns marked. */
function exported(table, row) {
  const withheld = (WITHHELD.get(table) ?? []).filter((column) => column in row);
  return { ...row, ...Object.fromEntries(withheld.map((column) => [column, 'withheld'])) };
}

/**
 * The business's copies as JSON lines, and the seeds by person; null when
 * no business has the key.
 */
async function scan(admin, { business, text, ids, exportRows }) {
  return await admin.transaction(async (execute) => {
    await execute('set transaction isolation level repeatable read, read only');
    await execute('set local row_security = off');
    const [owner] = await execute(`select id from public.businesses where key = $1`, [business]);
    if (owner === undefined) return null;
    const found = await execute(SEEDS, [owner.id, text ?? null, ids]);
    const seeds = found.filter((seed) => !seed.shared);
    const shared = found.filter((seed) => seed.shared);
    const sharedIds = new Set(shared.map((seed) => seed.id));
    const names = await execute(STORED_NAMES, [owner.id, seeds.map((seed) => seed.person)]);
    const tables = await execute(TABLES);
    const lines = [];
    for (const { name, kind, scoped } of tables) {
      if (!SAFE.test(name)) throw new Refusal(`unexpected table name ${JSON.stringify(name)}`);
      if (kind === 'm' || kind === 'f') {
        throw new Refusal(
          `${name} is a materialised view or foreign table, which it cannot vouch for`,
        );
      }
      if (!scoped) throw new Refusal(`table ${name} has no business_id`);
      // oxlint-disable-next-line no-await-in-loop
      const rows = await execute(copies(name), [
        text === undefined ? null : containing(text),
        owner.id,
        seeds.map((seed) => seed.id),
        seeds.map((seed) => seed.person),
        ids.filter((id) => !sharedIds.has(id)),
        names.filter(({ name }) => namesSomeone(name)).map(({ words }) => words),
        [...sharedIds],
      ]);
      for (const { address, row, columns, people, shared: agents, text: holdsText, given } of rows) {
        const hit = {
          table: name,
          id: row.id ?? address,
          columns,
          people,
          shared: agents,
          text: holdsText,
          given,
        };
        if (exportRows) hit.row = exported(name, row);
        lines.push(`${JSON.stringify(hit)}\n`);
      }
    }
    const byPerson = Map.groupBy(seeds, (seed) => seed.person);
    return { lines, byPerson, shared };
  });
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
  let admin;
  try {
    admin = connectAsAdmin(url, { source: 'privacy-find-copies' });
    const found = await scan(admin, options);
    if (found === null) {
      stderr.write(`find-copies: no business has the key ${JSON.stringify(options.business)}\n`);
      return 2;
    }
    stdout.write(found.lines.join(''));
    stderr.write(`find-copies: ${String(found.lines.length)} row(s) hold the text or an id\n`);
    // One line per person, so an erasure carries its own person's ids only.
    for (const [person, seeds] of found.byPerson) {
      const flags = seeds.map((seed) => `--id ${seed.id}`).join(' ');
      const how = seeds[0].how;
      stderr.write(
        `find-copies: to search again for ${person} (${how}) after an erasure, add: ${flags}\n`,
      );
    }
    // A shared agent stands for no one: its rows are listed under `shared`, for the owner to judge.
    for (const { id, person } of found.shared) {
      stderr.write(
        id === person
          ? `find-copies: ${id}, given with --id, is shared (an agent acting for others too, or its login), so it stands for no one; see shared\n`
          : `find-copies: agent ${id} acts for ${person} and for others, so it stands for no one; see shared\n`,
      );
    }
    return 0;
  } catch (error) {
    // A driver's error can carry the address, password and all, so only the
    // finder's own refusals are printed in words.
    const why = error instanceof Refusal ? error.message : 'the search failed';
    stderr.write(`find-copies: ${why}\n`);
    return 1;
  } finally {
    await admin?.close().catch(() => null);
  }
}

// Not exit(): the list is one large write, and exiting can cut a piped one short.
process.exitCode = await main();
