// SPDX-License-Identifier: AGPL-3.0-only
//
// The upgrade drill: `pnpm verify:upgrade-drill [--from <version>]`.
//
// It builds its own starting point and never touches an installation's data:
// a throwaway database on the local server, migrated to an older version and
// seeded there through the product's own commands, then upgraded to the head
// with the application stopped, then compared row for row. Every row that
// existed before the upgrade must still exist after it with the same values.
// A column a migration adds is not compared, because it holds no value the
// installation stored; a row a migration adds is counted and allowed. A row
// changed or lost, or a table gone, fails the drill. The report names tables
// and counts and never a row's content.
//
// The first drill was run by hand before slice one landed (0023 through 0031,
// 217 records identical) and its script was never committed; 0023 is the
// default for that reason. CI runs it from the base branch's newest migration
// whenever a pull request adds one (.github/workflows/ci.yml, `database
// conformance`). The seed runs this checkout's commands against the older
// schema, so it can seed only where the head's commands still fit that schema.
//
// "The application stopped" is the supported upgrade (scripts/db-migrate.mjs):
// the seed's pool is closed before the runner starts, and the runner refuses
// if any other session is still connected.
//
// Exit 0 when every row is unchanged, 1 when the drill fails, 2 when it is
// refused before building anything. `--json` adds the result as a last line.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { createEmptyDatabase } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const LEDGER = 'ops.schema_migrations';

const say = (line) => console.log(`upgrade-drill: ${line}`);

class Refused extends Error {}

/** `.local/db.env` is what `scripts/local/db-up.sh` writes. The environment wins. */
function serverUrl() {
  const set = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (set) return set;
  const file = `${root}.local/db.env`;
  if (!existsSync(file)) return;
  const match = /^DATABASE_ADMIN_URL=(.+)$/mu.exec(readFileSync(file, 'utf8'));
  return match?.[1];
}

/** A business and one person who may sign in and work its tasks, written as the application. */
async function enrolBusiness(app, key) {
  const [business, person, actor, login] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const subject = `${key}-${randomUUID()}`;
  await app.withBusiness(business, async (tx) => {
    const rows = [
      ['insert into businesses (business_id, id, key, name) values ($1, $1, $2, $2)', [key]],
      ['insert into people (business_id, id, display_name) values ($1, $2, $3)', [person, key]],
      [
        `insert into actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
        [actor, person],
      ],
      [
        `insert into memberships (business_id, id, person_id, role_key) values ($1, $2, $3, 'member')`,
        [randomUUID(), person],
      ],
      [
        `insert into logins (business_id, id, provider, subject) values ($1, $2, 'supabase', $3)`,
        [login, subject],
      ],
      [
        `insert into person_logins (business_id, id, login_id, person_id, active, linked_by_actor_id)
         values ($1, $2, $3, $4, true, $5)`,
        [randomUUID(), login, person, actor],
      ],
    ];
    for (const [sql, values] of rows) {
      // oxlint-disable-next-line no-await-in-loop
      await tx.query(sql, [business, ...values]);
    }
    await installTaskSpine(tx);
    for (const action of ['read', 'write', 'comment', 'assign']) {
      // oxlint-disable-next-line no-await-in-loop
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: person },
        scope: { kind: 'business', id: null },
        collection: 'task',
        action,
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: actor,
      });
      if (!issued.ok)
        throw new Error(`the seed's ${action} grant was refused: ${issued.refusal.code}`);
    }
  });
  return { business, presented: { provider: 'supabase', subject } };
}

/** Tasks with a history: created, renamed, started, commented, completed and reopened. */
async function seedTasks(app, key, { business, presented }) {
  const revisions = new Map();
  const run = async (request) => {
    const target = request.recordId;
    const outcome = await executeCommand(app, business, presented, 'api', {
      operationId: randomUUID(),
      ...(target === undefined ? {} : { expectedRevision: revisions.get(target) }),
      ...request,
    });
    if (isCommandRefusal(outcome)) {
      throw new Error(`the seed's ${request.command} was refused: ${outcome.code}`);
    }
    if (outcome.recordId === (target ?? outcome.recordId)) {
      revisions.set(outcome.recordId, outcome.revision);
    }
    return outcome.recordId;
  };
  const first = await run({ command: 'task.create', fields: { title: `${key} first task` } });
  const second = await run({ command: 'task.create', fields: { title: `${key} second task` } });
  await run({ command: 'task.create', fields: { title: `${key} third task` } });
  await run({
    command: 'task.update',
    recordId: first,
    fields: { title: `${key} first, renamed` },
  });
  await run({ command: 'task.start', recordId: first });
  const note = { body: 'a seeded note', audience: 'internal' };
  await run({ command: 'task.comment', recordId: second, ...note });
  await run({ command: 'task.complete', recordId: second });
  await run({ command: 'task.reopen', recordId: second, reason: 'seeded reopen' });
}

/** Two businesses, so the snapshot holds more than one tenant's rows. */
async function seed(app) {
  await seedTasks(app, 'drill-alpha', await enrolBusiness(app, 'drill-alpha'));
  await seedTasks(app, 'drill-bravo', await enrolBusiness(app, 'drill-bravo'));
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Every ordinary table and its rows as `jsonb` text, read as the owner. Given
 * the snapshot before, a table's rows are read without the columns added since.
 */
async function snapshot(admin, before) {
  const tables = await admin.execute(
    `select n.nspname || '.' || c.relname as name, n.nspname as schema, c.relname as relname,
            array(select a.attname::text from pg_attribute a
                   where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
      order by 1`,
  );
  const shot = new Map();
  for (const table of tables) {
    if (table.name === LEDGER) continue;
    const earlier = before?.get(table.name)?.columns ?? table.columns;
    const added = table.columns.filter((column) => !earlier.includes(column));
    // oxlint-disable-next-line no-await-in-loop
    const rows = await admin.execute(
      `select (to_jsonb(t) - $1::text[])::text as row from ${quote(table.schema)}.${quote(table.relname)} t`,
      [added],
    );
    shot.set(table.name, { columns: table.columns, rows: rows.map((r) => r.row) });
  }
  return shot;
}

/** Each table whose earlier rows are not all still there, unchanged. */
function compare(before, after) {
  const differences = [];
  for (const [table, { rows }] of before) {
    const now = after.get(table);
    if (now === undefined) {
      differences.push({ table, changedOrLost: rows.length, added: 0, gone: true });
      continue;
    }
    const waiting = new Map();
    for (const row of rows) waiting.set(row, (waiting.get(row) ?? 0) + 1);
    let added = 0;
    for (const row of now.rows) {
      const count = waiting.get(row) ?? 0;
      if (count > 0) waiting.set(row, count - 1);
      else added += 1;
    }
    const changedOrLost = [...waiting.values()].reduce((sum, n) => sum + n, 0);
    if (changedOrLost > 0) differences.push({ table, changedOrLost, added, gone: false });
  }
  return differences;
}

async function drill({ url, from, directory }) {
  const all = readMigrations(directory);
  const at = all.findIndex((m) => m.version === from || m.version.startsWith(`${from}_`));
  if (at === -1) throw new Refused(`no migration ${from} among the ${all.length} read`);
  if (at === all.length - 1)
    throw new Refused(`${all[at].version} is the head: nothing to upgrade`);
  const start = all[at].version;
  const to = all.at(-1).version;

  const db = await createEmptyDatabase({ serverUrl: url, part: 'drill' });
  try {
    // Row security would hide rows from the snapshot and the drill would pass
    // over what it could not see, so the owner must be above it.
    const [owner] = await db.admin.execute(
      `select rolsuper or rolbypassrls as above from pg_roles where rolname = current_user`,
    );
    if (owner?.above !== true) throw new Refused('the owner role is subject to row security');
    await applyMigrations(db.admin, all.slice(0, at + 1));
    await seed(db.app);
    // The application stopped: the seed's pool is closed and holds no session.
    await db.closeSessions();
    const before = await snapshot(db.admin);
    const rows = [...before.values()].reduce((sum, t) => sum + t.rows.length, 0);
    if (rows === 0)
      throw new Error('the seed left no row the owner can read, so nothing would be compared');
    say(`built at ${start} and seeded: ${rows} rows in ${before.size} tables; application stopped`);
    const { applied } = await applyMigrations(db.admin, all);
    say(`upgraded ${start} -> ${to}: applied ${applied.join(', ')}`);
    const differences = compare(before, await snapshot(db.admin, before));
    return {
      ok: differences.length === 0,
      from: start,
      to,
      applied,
      tables: before.size,
      rows,
      differences,
    };
  } finally {
    await db.drop();
  }
}

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: '0023' },
    migrations: { type: 'string', default: `${root}migrations` },
    json: { type: 'boolean', default: false },
  },
});

const url = serverUrl();
try {
  if (!url) throw new Refused('no DATABASE_ADMIN_URL. Run scripts/local/db-up.sh first.');
  const result = await drill({ url, from: values.from, directory: values.migrations });
  for (const d of result.differences) {
    say(
      d.gone
        ? `${d.table}: table gone, ${d.changedOrLost} row(s) lost`
        : `${d.table}: ${d.changedOrLost} row${d.changedOrLost === 1 ? '' : 's'} changed or lost, ${d.added} added`,
    );
  }
  say(
    result.ok
      ? `passed: ${result.rows} rows in ${result.tables} tables unchanged from ${result.from} to ${result.to}`
      : `FAILED: ${result.differences.length} table(s) changed from ${result.from} to ${result.to}`,
  );
  if (values.json) console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(
    `upgrade-drill: ${error instanceof Refused ? 'refused' : 'failed'}: ${error.message}`,
  );
  process.exitCode = error instanceof Refused ? 2 : 1;
}
