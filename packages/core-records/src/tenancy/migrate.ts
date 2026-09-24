// SPDX-License-Identifier: AGPL-3.0-only
//
// The migration runner. Numbered SQL files are the only schema truth, so this
// is the only thing in the tree that changes a schema.
//
// The properties it holds, each because its absence has a known failure.
//
// - One run is all or nothing. Every pending file is applied in one
//   transaction, each file's ledger row written after its statements, with one
//   commit at the end. A file and its ledger row therefore commit together, and
//   a refusal or a failed statement anywhere leaves the database at the version
//   it started at: a run cannot stop between two files (SOL-FR6-2).
//   PostgreSQL runs DDL inside transactions, which is what makes this possible
//   at all, and a file holding a statement it will not run inside one is
//   refused before anything runs.
// - An applied migration's checksum is checked on every run, before anything
//   runs. Editing a file that has already been applied is refused rather than
//   ignored, because the database and the file would otherwise disagree in
//   silence.
// - Statements are split and sent one at a time, so the statement log and any
//   error name the statement rather than the file.
// - It checks, when anything is pending, that no other client session is
//   connected to the database, and refuses to apply anything if one is. The
//   supported upgrade is the application stopped, and a migration run beside a
//   live application has two known ways to go wrong in 0030 alone (SOL-R3R-1,
//   SOL-R3R2-1). The check is a backstop to stopping the application, not the
//   stop: an idle application that holds no connection passes it
//   (docs/local/DATA.md, "Upgrade"). A role that cannot read every session is
//   refused rather than trusted to have seen nobody.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminConnection } from './database.ts';
import { classifyStatement, scanToken, splitStatements } from './statements.ts';

export interface Migration {
  readonly version: string;
  readonly checksum: string;
  readonly statements: readonly string[];
}

export interface MigrationOutcome {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export function readMigrations(directory: string): readonly Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
    .map((name) => {
      const bytes = readFileSync(join(directory, name));
      return {
        version: name.slice(0, -'.sql'.length),
        checksum: createHash('sha256').update(bytes).digest('hex'),
        statements: splitStatements(bytes.toString('utf8')),
      };
    });
}

/** A session the runner found on its database that is not its own. */
export interface ConnectedSession {
  readonly pid: number;
  readonly usename: string | null;
  readonly application_name: string | null;
  readonly client_addr: string | null;
  readonly backend_start: string | null;
}

/**
 * Thrown when pending migrations meet other sessions on the database.
 *
 * Wherever the run was when it looked, nothing was applied: before the
 * transaction nothing had started, and inside it the whole run rolls back.
 */
export class MigrationRefused extends Error {
  readonly sessions: readonly ConnectedSession[];
  readonly pending: readonly string[];

  constructor(sessions: readonly ConnectedSession[], pending: readonly string[]) {
    const named = sessions
      .map(
        (s) =>
          `pid ${String(s.pid)} login ${s.usename ?? '?'} application "${s.application_name ?? ''}" ` +
          `from ${s.client_addr ?? 'local socket'} since ${s.backend_start ?? '?'}`,
      )
      .join('; ');
    super(
      `migrate: refusing to apply ${String(pending.length)} pending migration(s) ` +
        `(${pending.join(', ')}) while ${String(sessions.length)} other session(s) are connected ` +
        `to this database: ${named}. Nothing was applied. Stop the application (the API and GoTrue) and ` +
        `anything else connected to this database, then run it again.`,
    );
    this.name = 'MigrationRefused';
    this.sessions = sessions;
    this.pending = pending;
  }
}

/**
 * Every client backend on this database except the one asking.
 *
 * `pg_stat_activity` is read from a snapshot the backend takes on first use
 * and keeps until its transaction ends, so a check inside a transaction clears
 * it first; without that, the check before commit would repeat the answer the
 * check at the start of the transaction got. The runner's own connection is
 * `pg_backend_pid()`. A second backend of the runner's own pool would be
 * counted, which fails closed: `connectAsAdmin` opens one (`max` defaults to 1)
 * and the runner never runs two statements at once.
 */
const OTHER_SESSIONS = `select pid, usename::text as usename, application_name,
       host(client_addr) as client_addr, backend_start::text as backend_start
  from pg_stat_activity
 where datname = current_database()
   and backend_type = 'client backend'
   and pid <> pg_backend_pid()
 order by pid`;

async function otherSessions(
  execute: AdminConnection['execute'],
): Promise<readonly ConnectedSession[]> {
  await execute(`select pg_stat_clear_snapshot()`);
  return await execute<ConnectedSession>(OTHER_SESSIONS);
}

/** Refuse, naming what is connected, when anything but this backend is. */
/**
 * Thrown when the runner's role cannot read every session's row in
 * `pg_stat_activity`. PostgreSQL hides `backend_type` for another role's
 * session from a role that is neither superuser nor in `pg_read_all_stats`,
 * so the connection check would find nobody and pass. It refuses instead.
 */
export class MigrationRoleCannotSee extends Error {
  readonly role: string;
  readonly pending: readonly string[];

  constructor(role: string, pending: readonly string[]) {
    super(
      `migrate: refusing to apply ${String(pending.length)} pending migration(s) ` +
        `(${pending.join(', ')}): the role ${role} cannot read every session in ` +
        `pg_stat_activity, so it cannot tell whether anything else is connected. Nothing was ` +
        `applied. Run it as a superuser, or grant ${role} pg_read_all_stats.`,
    );
    this.name = 'MigrationRoleCannotSee';
    this.role = role;
    this.pending = pending;
  }
}

/**
 * Refuse unless this role sees every session. Asked of the role rather than
 * of the rows: a role that cannot see them also sees autovacuum and other
 * background workers with a null `backend_type`, so counting hidden rows as
 * connected would refuse at random.
 */
async function refuseIfBlind(
  execute: AdminConnection['execute'],
  pending: readonly string[],
): Promise<void> {
  const [row] = await execute<{ readonly role: string; readonly sees: boolean }>(
    `select current_user::text as role,
            coalesce((select rolsuper from pg_roles where rolname = current_user), false)
              or pg_has_role(current_user, 'pg_read_all_stats', 'usage') as sees`,
  );
  if (row?.sees !== true) throw new MigrationRoleCannotSee(row?.role ?? '?', pending);
}

async function refuseIfConnected(
  execute: AdminConnection['execute'],
  pending: readonly string[],
): Promise<void> {
  const sessions = await otherSessions(execute);
  if (sessions.length > 0) throw new MigrationRefused(sessions, pending);
}

/**
 * Statements PostgreSQL 18 refuses inside a transaction block (its
 * `PreventInTransactionBlock` callers), read over `words` of the statement.
 * REINDEX of a partitioned table or index and CLUSTER of a partitioned table
 * are refused too, and the text cannot say what is partitioned, so every
 * REINDEX and CLUSTER is. A pattern that also matches something harmless
 * refuses it, which fails closed; a file that really needs one of these is a
 * change to how the runner applies files, not a file to slip past it. The
 * statements that would end the runner's own transaction are the scanner's
 * `transaction` kind, plus PREPARE TRANSACTION. `ALTER TYPE ... ADD VALUE` is
 * not refused: PostgreSQL 12 and later run it inside a block, and a later use
 * of the new value in the same run fails and rolls the whole run back (the
 * ALTER TYPE reference page, Notes).
 */
const OUTSIDE_A_TRANSACTION: readonly RegExp[] = [
  /^(create (unique )?index|drop index)\b.*\bconcurrently\b/u,
  /^alter table\b.*\bdetach partition\b.*\bconcurrently\b/u,
  /^(vacuum|reindex|cluster|alter system|discard all|prepare transaction)\b/u,
  /^(create|drop) (database|tablespace)\b/u,
  /^alter database\b.*\bset tablespace\b/u,
  /^(create|alter|drop) subscription\b/u,
];

/**
 * The statement's own words, lower case and single spaced, read with the
 * statement splitter's scanner: a comment, nested or not, is a space, and a
 * quoted string, quoted identifier or dollar-quoted body is one `?`, so no
 * word inside one can hide a statement or match a pattern.
 */
function words(statement: string): string {
  let text = '';
  let at = 0;
  while (at < statement.length) {
    const token = scanToken(statement, at);
    if (token.kind === 'comment') text += ' ';
    else if (token.kind === 'quoted') text += ' ? ';
    else text += statement.slice(at, token.end);
    at = token.end;
  }
  return text.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

/** Refuse, before anything runs, a file holding a statement the one transaction cannot. */
function refuseOutsideATransaction(migrations: readonly Migration[]): void {
  for (const migration of migrations) {
    for (const statement of migration.statements) {
      const read = words(statement);
      if (
        classifyStatement(statement) === 'transaction' ||
        OUTSIDE_A_TRANSACTION.some((pattern) => pattern.test(read))
      ) {
        throw new Error(
          `migrate: ${migration.version} holds a statement PostgreSQL will not run inside a ` +
            `transaction block, or one that would end it, and every pending file is applied in ` +
            `one transaction: ${statement.slice(0, 200)}. Nothing was applied.`,
        );
      }
    }
  }
}

interface LedgerRow {
  readonly version: string;
  readonly checksum: string;
}

async function readLedger(
  admin: AdminConnection,
): Promise<ReadonlyMap<string, string> | undefined> {
  const [present] = await admin.execute<{ readonly ledger: string | null }>(
    `select to_regclass('ops.schema_migrations')::text as ledger`,
  );
  if (present === undefined || present.ledger === null) return undefined;
  const rows = await admin.execute<LedgerRow>(
    `select version, checksum from ops.schema_migrations`,
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

export async function migrate(
  admin: AdminConnection,
  directory: string,
): Promise<MigrationOutcome> {
  return await applyMigrations(admin, readMigrations(directory));
}

/** What the ledger already holds, checked against its file, and what it does not. */
function splitByLedger(
  ledger: ReadonlyMap<string, string> | undefined,
  migrations: readonly Migration[],
): { readonly pending: readonly Migration[]; readonly alreadyApplied: readonly string[] } {
  const pending: Migration[] = [];
  const alreadyApplied: string[] = [];
  for (const migration of migrations) {
    const recorded = ledger?.get(migration.version);
    if (recorded === undefined) {
      pending.push(migration);
      continue;
    }
    if (recorded !== migration.checksum) {
      throw new Error(
        `migrate: ${migration.version} was applied as ${recorded} but the file now hashes to ` +
          `${migration.checksum}. An applied migration is history; write a new one.`,
      );
    }
    alreadyApplied.push(migration.version);
  }
  return { pending, alreadyApplied };
}

/**
 * The same run over a list somebody else read.
 *
 * It exists so that the prefix harness can apply `0001` through `000k` and
 * stop, without copying files into a temporary directory to do it. A prefix is
 * a state an installation is really in between two migrations, and proving
 * anything about it means being able to stand there.
 */
export async function applyMigrations(
  admin: AdminConnection,
  migrations: readonly Migration[],
): Promise<MigrationOutcome> {
  refuseOutsideATransaction(migrations);
  const { pending, alreadyApplied } = splitByLedger(await readLedger(admin), migrations);
  // Nothing pending is nothing to protect, so an up-to-date database with the
  // application running passes.
  if (pending.length === 0) return { applied: [], alreadyApplied };
  const names = pending.map((migration) => migration.version);
  // The one transaction rolls a failure back to where the run started.
  const last = alreadyApplied.at(-1);
  const startedAt = last === undefined ? 'without any migration' : `at ${last}`;

  // The check runs before the transaction, inside it before each file, and
  // once more before the commit, so a session that connects after the first
  // look still refuses the run, and the whole run rolls back.
  await refuseIfBlind(admin.execute, names);
  await refuseIfConnected(admin.execute, names);
  await admin.transaction(async (execute) => {
    // Migrations are ordered and each one may depend on the last, so they are
    // applied one at a time on purpose. The same goes for the statements
    // inside one migration. `Promise.all` here would apply a schema in an
    // order nobody wrote.
    for (const migration of pending) {
      // oxlint-disable-next-line no-await-in-loop
      await refuseIfConnected(execute, names);
      for (const statement of migration.statements) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await execute(statement);
        } catch (cause) {
          throw new Error(
            `migrate: ${migration.version} failed on: ${statement.slice(0, 200)}. Nothing was ` +
              `applied; the database is still ${startedAt}.`,
            { cause },
          );
        }
      }
      // oxlint-disable-next-line no-await-in-loop
      await execute(`insert into ops.schema_migrations (version, checksum) values ($1, $2)`, [
        migration.version,
        migration.checksum,
      ]);
    }
    await refuseIfConnected(execute, names);
  });
  return { applied: names, alreadyApplied };
}
