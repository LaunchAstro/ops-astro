// SPDX-License-Identifier: AGPL-3.0-only
//
// The migration runner. Numbered SQL files are the only schema truth, so this
// is the only thing in the tree that changes a schema.
//
// Three properties it holds, each because its absence has a known failure.
//
// - A file and its ledger row commit together, so a half-applied migration
//   cannot be recorded as applied. PostgreSQL runs DDL inside transactions,
//   which is what makes this possible at all.
// - An applied migration's checksum is checked on every run. Editing a file
//   that has already been applied is refused rather than ignored, because the
//   database and the file would otherwise disagree in silence.
// - Statements are split and sent one at a time, so the statement log and any
//   error name the statement rather than the file.
// - It refuses to apply anything while another session is connected to the
//   database. The supported upgrade is the application stopped, and a
//   migration run beside a live application has two known ways to go wrong in
//   0030 alone (SOL-R3R-1, SOL-R3R2-1), so the rule is enforced here rather
//   than left to a document.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminConnection } from './database.ts';
import { splitStatements } from './statements.ts';

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
 * Before the first migration it means nothing was applied. From inside a
 * migration's transaction it means that migration was rolled back and the
 * ones before it in the same run stayed committed; `applied` names them.
 */
export class MigrationRefused extends Error {
  readonly sessions: readonly ConnectedSession[];
  readonly pending: readonly string[];
  readonly applied: readonly string[];

  constructor(
    sessions: readonly ConnectedSession[],
    pending: readonly string[],
    applied: readonly string[],
  ) {
    const named = sessions
      .map(
        (s) =>
          `pid ${String(s.pid)} login ${s.usename ?? '?'} application "${s.application_name ?? ''}" ` +
          `from ${s.client_addr ?? 'local socket'} since ${s.backend_start ?? '?'}`,
      )
      .join('; ');
    const done =
      applied.length === 0
        ? 'Nothing was applied.'
        : `Applied and committed before the refusal: ${applied.join(', ')}. Nothing else was applied.`;
    super(
      `migrate: refusing to apply ${String(pending.length)} pending migration(s) ` +
        `(${pending.join(', ')}) while ${String(sessions.length)} other session(s) are connected ` +
        `to this database: ${named}. ${done} Stop the application (the API and GoTrue) and ` +
        `anything else connected to this database, then run it again.`,
    );
    this.name = 'MigrationRefused';
    this.sessions = sessions;
    this.pending = pending;
    this.applied = applied;
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
async function refuseIfConnected(
  execute: AdminConnection['execute'],
  pending: readonly string[],
  applied: readonly string[],
): Promise<void> {
  const sessions = await otherSessions(execute);
  if (sessions.length > 0) {
    throw new MigrationRefused(sessions, pending.slice(applied.length), [...applied]);
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
  const { pending, alreadyApplied } = splitByLedger(await readLedger(admin), migrations);
  const applied: string[] = [];

  // Nothing pending is nothing to protect, so an up-to-date database with the
  // application running passes. Otherwise the check runs before the first
  // migration and again inside each one's transaction, before its statements
  // and before its commit, so a session that connects after this first look
  // still refuses the migration it arrives during.
  const names = pending.map((migration) => migration.version);
  if (pending.length > 0) await refuseIfConnected(admin.execute, names, applied);

  for (const migration of pending) {
    // Migrations are ordered and each one may depend on the last, so they are
    // applied one at a time on purpose. The same goes for the statements
    // inside one migration. `Promise.all` here would apply a schema in an
    // order nobody wrote.
    // oxlint-disable-next-line no-await-in-loop
    await admin.transaction(async (execute) => {
      await refuseIfConnected(execute, names, applied);
      for (const statement of migration.statements) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await execute(statement);
        } catch (cause) {
          throw new Error(`migrate: ${migration.version} failed on: ${statement.slice(0, 200)}`, {
            cause,
          });
        }
      }
      await execute(`insert into ops.schema_migrations (version, checksum) values ($1, $2)`, [
        migration.version,
        migration.checksum,
      ]);
      await refuseIfConnected(execute, names, applied);
    });
    applied.push(migration.version);
  }

  return { applied, alreadyApplied };
}
