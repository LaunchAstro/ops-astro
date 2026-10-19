// SPDX-License-Identifier: AGPL-3.0-only
//
// The migration runner. The SQL files in migrations/ are the only schema truth, so this
// is the only thing in the tree that changes a schema.
//
// The properties it holds, each because its absence has a known failure.
//
// - Files apply in version order, and every ID in the directory is well
//   formed and unique (migration-ids.ts), so a fresh install has one order.
// - One run is all or nothing. Every pending file is applied in one
//   transaction, each file's ledger row written after its statements, with one
//   commit at the end. A file and its ledger row therefore commit together, and
//   a refusal or a failed statement anywhere leaves the database at the version
//   it started at: a run cannot stop between two files.
//   PostgreSQL runs DDL inside transactions, which is what makes this possible
//   at all, and a file holding a statement it will not run inside one is
//   refused before anything runs.
// - A run that loses a race on a shared catalogue row is applied again. Roles
//   are the cluster's, so two databases migrating at once can both judge the
//   same role and alter it, and the second fails with XX000 "tuple
//   concurrently updated" (0046's lookup role, OW-007.3). That run rolled back
//   whole, so it starts again, up to five attempts with a short jittered
//   pause, and then reads the role as the other database left it
//   (`retryOnSharedRace`).
// - An applied migration's checksum is checked on every run, before anything
//   runs. Editing a file that has already been applied is refused rather than
//   ignored, because the database and the file would otherwise disagree in
//   silence.
// - Statements are split and sent one at a time, so the statement log and any
//   error name the statement rather than the file.
// - It takes its locks before it looks. When anything is pending, the one
//   transaction first bounds every lock wait to 5 s (`lock_timeout`, for the
//   transaction only), then locks every table in `ops` and `public` in ACCESS
//   EXCLUSIVE mode in one statement, then checks the other sessions. So a
//   session that starts a statement on one of those tables mid-run waits for
//   the commit and then sees the new schema.
// - It refuses to apply anything beside a session that could be using the old
//   schema: one that is active, has a transaction open (idle or aborted in
//   it), or holds any lock. A session that is idle with no transaction and no
//   lock passes, which is what a transaction-mode pooler such as Supavisor
//   keeps open and refills when it is ended (#1984). So does one whose only
//   wait is on the runner's own locks: it has not touched those tables, and it
//   sees the new schema when the run commits. The supported upgrade is the
//   application stopped, and a migration run beside a live application has two
//   known ways to go wrong in 0030 alone. The check is a backstop to stopping
//   the application, not the stop (docs/local/DATA.md, "Upgrade"). A role that
//   cannot read every session is refused rather than trusted to have seen
//   nobody. Hosted Supabase's own service logins, named one by one, are not
//   counted: they never stop, and their schemas are never locked.
// - A lock wait that times out (55P03) anywhere in the run rolls it back whole,
//   and the run is applied again from the ledger read, three attempts in all
//   10 s apart, then refused naming the sessions that counted at the last look
//   (`MigrationLockTimeout`). The attempts, the timeout and the pause are
//   options for the tests; the CLI passes none.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { AdminConnection } from './database.ts';
import { migrationIdProblems } from './migration-ids.ts';
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
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  // A symlink's target could change with no change to the file git tracks here.
  const problems = [
    ...names
      .filter((name) => !lstatSync(join(directory, name)).isFile())
      .map((name) => `${name.slice(0, -'.sql'.length)}, which is not a regular file`),
    ...migrationIdProblems(names.map((name) => name.slice(0, -'.sql'.length))),
  ];
  if (problems.length > 0) {
    throw new Error(`migrate: ${directory} holds ${problems.join('; ')}. Nothing was applied.`);
  }
  return names.map((name) => {
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

/** A session that could be using the old schema, with what makes it count. */
export interface BusySession extends ConnectedSession {
  readonly state: string | null;
  readonly xact_start: string | null;
  /** The locks it holds, as `<mode> on <relation or lock type>`, or null for none. */
  readonly holds: string | null;
}

function named(sessions: readonly BusySession[]): string {
  if (sessions.length === 0) return 'none';
  return sessions
    .map(
      (s) =>
        `pid ${String(s.pid)} login ${s.usename ?? '?'} application "${s.application_name ?? ''}" ` +
        `from ${s.client_addr ?? 'local socket'} since ${s.backend_start ?? '?'}, ` +
        `state ${s.state ?? '?'}, transaction since ${s.xact_start ?? 'none'}, ` +
        `holding ${s.holds ?? 'no lock'}`,
    )
    .join('; ');
}

/**
 * Thrown when pending migrations meet sessions that could be using the old
 * schema.
 *
 * Every look is inside the run's one transaction, so nothing was applied: the
 * whole run rolls back.
 */
export class MigrationRefused extends Error {
  readonly sessions: readonly BusySession[];
  readonly pending: readonly string[];

  constructor(sessions: readonly BusySession[], pending: readonly string[], startedAt: string) {
    super(
      `migrate: refusing to apply ${String(pending.length)} pending migration(s) ` +
        `(${pending.join(', ')}) while ${String(sessions.length)} other session(s) could be using ` +
        `the old schema (active, in a transaction or holding a lock): ${named(sessions)}. ` +
        `Nothing was applied. The database is still ${startedAt}. Stop the application (the API ` +
        `and GoTrue) and anything else working on this database, then run it again.`,
    );
    this.name = 'MigrationRefused';
    this.sessions = sessions;
    this.pending = pending;
  }
}

/**
 * Thrown when a lock wait timed out on every attempt. Each attempt rolled back
 * whole, so nothing was applied. `sessions` are the ones that counted at a
 * look taken after the last attempt.
 */
export class MigrationLockTimeout extends Error {
  readonly sessions: readonly BusySession[];
  readonly pending: readonly string[];
  readonly attempts: number;

  constructor(
    sessions: readonly BusySession[],
    pending: readonly string[],
    timing: LockTiming,
    startedAt: string,
  ) {
    super(
      `migrate: refusing to apply ${String(pending.length)} pending migration(s) ` +
        `(${pending.join(', ')}): a lock wait passed ${String(timing.timeoutMs)} ms on each of ` +
        `${String(timing.attempts)} attempt(s), ${String(timing.pauseMs)} ms apart. Sessions that ` +
        `could be using the old schema at the last look: ${named(sessions)}. Nothing was applied. ` +
        `The database is still ${startedAt}. Stop what holds the lock, then run it again.`,
    );
    this.name = 'MigrationLockTimeout';
    this.sessions = sessions;
    this.pending = pending;
    this.attempts = timing.attempts;
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

/**
 * Hosted Supabase's own services, which stay connected while the application
 * is stopped, by the exact login each uses and never a pattern. Data API
 * (`authenticator`), Auth (`supabase_auth_admin`), Storage
 * (`supabase_storage_admin`) and Realtime (`supabase_admin`):
 * supabase/supabase docker/docker-compose.yml at be976be. The pooler's auth
 * query (`pgbouncer`): supabase/postgres
 * ansible/files/pgbouncer_config/pgbouncer.ini.j2 at 9b0996e. None of these
 * roles exists on the local install, where GoTrue connects as `postgres`.
 */
const HOSTED_SERVICE_LOGINS: ReadonlySet<string> = new Set([
  'authenticator',
  'pgbouncer',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
]);

/**
 * The sessions a run refuses to apply beside, by the rule `migrate` applies:
 * exported so a caller about to make work it cannot undo asks first.
 */
export async function otherSessions(
  execute: AdminConnection['execute'],
): Promise<readonly ConnectedSession[]> {
  await execute(`select pg_stat_clear_snapshot()`);
  const sessions = await execute<ConnectedSession>(OTHER_SESSIONS);
  return sessions.filter((s) => s.usename === null || !HOSTED_SERVICE_LOGINS.has(s.usename));
}

/**
 * The sessions of `OTHER_SESSIONS` that could be using the old schema: not
 * idle, or with a transaction open, or holding or awaiting any lock. A null
 * state counts. One whose wait is on a lock and whom only this backend blocks
 * does not: inside the run, that is a statement queued behind the run's own
 * locks, which has touched none of those tables and reads them after the
 * commit. Outside a transaction this backend holds nothing, so the clause
 * matches nobody.
 */
const BUSY_SESSIONS = `select a.pid, a.usename::text as usename, a.application_name,
       host(a.client_addr) as client_addr, a.backend_start::text as backend_start,
       a.state, a.xact_start::text as xact_start,
       (select string_agg(held.lock, ', ' order by held.lock)
          from (select distinct l.mode || ' on ' || coalesce(l.relation::regclass::text, l.locktype) as lock
                  from pg_locks l where l.pid = a.pid and l.granted) held) as holds
  from pg_stat_activity a
 where a.datname = current_database()
   and a.backend_type = 'client backend'
   and a.pid <> pg_backend_pid()
   and (a.state is distinct from 'idle'
        or a.xact_start is not null
        or exists (select 1 from pg_locks l where l.pid = a.pid))
   and not (a.wait_event_type is not distinct from 'Lock'
            and pg_blocking_pids(a.pid) = array[pg_backend_pid()])
 order by a.pid`;

/**
 * The sessions a run refuses to apply beside (`MigrationRefused`). Narrower
 * than `otherSessions`, which a caller about to empty a database still asks.
 */
export async function busySessions(
  execute: AdminConnection['execute'],
): Promise<readonly BusySession[]> {
  await execute(`select pg_stat_clear_snapshot()`);
  const sessions = await execute<BusySession>(BUSY_SESSIONS);
  return sessions.filter((s) => s.usename === null || !HOSTED_SERVICE_LOGINS.has(s.usename));
}

/**
 * Thrown when the runner's role cannot read every session's row in
 * `pg_stat_activity`. PostgreSQL hides `backend_type` for another role's
 * session from a role that is neither superuser nor in `pg_read_all_stats`,
 * so the connection check would find nobody and pass. It refuses instead.
 */
export class MigrationRoleCannotSee extends Error {
  readonly role: string;
  readonly pending: readonly string[];

  constructor(role: string, pending: readonly string[], startedAt: string) {
    super(
      `migrate: refusing to apply ${String(pending.length)} pending migration(s) ` +
        `(${pending.join(', ')}): the role ${role} cannot read every session in ` +
        `pg_stat_activity, so it cannot tell whether anything else is connected. Nothing was ` +
        `applied. The database is still ${startedAt}. Run it as a superuser, or grant ${role} ` +
        `pg_read_all_stats.`,
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
  startedAt: string,
): Promise<void> {
  const [row] = await execute<{ readonly role: string; readonly sees: boolean }>(
    `select current_user::text as role,
            coalesce((select rolsuper from pg_roles where rolname = current_user), false)
              or pg_has_role(current_user, 'pg_read_all_stats', 'usage') as sees`,
  );
  if (row?.sees !== true) throw new MigrationRoleCannotSee(row?.role ?? '?', pending, startedAt);
}

async function refuseIfBusy(
  execute: AdminConnection['execute'],
  pending: readonly string[],
  startedAt: string,
): Promise<void> {
  const sessions = await busySessions(execute);
  if (sessions.length > 0) throw new MigrationRefused(sessions, pending, startedAt);
}

/**
 * Every ordinary and partitioned table in the schemas the migrations own, in
 * one fixed order, quoted. Supabase's own schemas are not among them.
 */
const OWN_TABLES = `select format('%I.%I', n.nspname, c.relname) as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('ops', 'public') and c.relkind in ('r', 'p')
 order by n.nspname, c.relname`;

/** Bound every lock wait in the transaction, then lock every table it may alter. */
async function lockFirst(execute: AdminConnection['execute'], timeoutMs: number): Promise<void> {
  // set_config rather than SET LOCAL, which the statement log cannot read.
  await execute(`select set_config('lock_timeout', $1, true)`, [`${String(timeoutMs)}ms`]);
  const tables = await execute<{ readonly name: string }>(OWN_TABLES);
  if (tables.length === 0) return;
  await execute(`lock table ${tables.map((t) => t.name).join(', ')} in access exclusive mode`);
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
 * not refused: PostgreSQL 12 and later run it inside a block. A use of the new
 * value later in the same run fails, and rolls the run back whole, when the
 * enum type was committed before the run, as on every upgrade. When the type
 * was created earlier in the same run, as on a fresh install, the use
 * succeeds, so a fresh-install gate cannot catch it. Ship an ADD VALUE and its
 * first use in different releases (the ALTER TYPE reference page, Notes).
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

/**
 * The id of the transaction a statement runs in. Asking assigns one, so a
 * statement that ended the run's transaction shows as a different id: the
 * next statement runs in a transaction of its own.
 */
async function transactionId(execute: AdminConnection['execute']): Promise<string> {
  const [row] = await execute<{ readonly xid: string }>(`select pg_current_xact_id()::text as xid`);
  return row?.xid ?? '';
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

/** How long a run waits on one lock, and how often and how far apart it tries. */
export interface MigrateOptions {
  /** Attempts in all while a lock wait times out. Default 3. */
  readonly lockAttempts?: number;
  /** The run's `lock_timeout`. Default 5000. */
  readonly lockTimeoutMs?: number;
  /** The pause before the next attempt. Default 10000. */
  readonly lockPauseMs?: number;
}

interface LockTiming {
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly pauseMs: number;
}

/** The options with their defaults, each a whole number in range or refused. */
function lockTiming(options: MigrateOptions): LockTiming {
  const timing = {
    attempts: options.lockAttempts ?? 3,
    timeoutMs: options.lockTimeoutMs ?? 5000,
    pauseMs: options.lockPauseMs ?? 10_000,
  };
  for (const [option, value, least] of [
    ['lockAttempts', timing.attempts, 1],
    ['lockTimeoutMs', timing.timeoutMs, 1],
    ['lockPauseMs', timing.pauseMs, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < least) {
      throw new Error(`migrate: ${option} must be a whole number of at least ${String(least)}`);
    }
  }
  return timing;
}

export async function migrate(
  admin: AdminConnection,
  directory: string,
  options: MigrateOptions = {},
): Promise<MigrationOutcome> {
  return await applyMigrations(admin, readMigrations(directory), options);
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

/** How many times a run is applied while each attempt loses the shared catalogue race. */
const SHARED_RACE_ATTEMPTS = 5;

/**
 * Whether a statement failed only because another database's transaction
 * updated the same shared catalogue row (a role) first. PostgreSQL waits for
 * that transaction, then refuses the update rather than redo it: XX000 with
 * this exact message. The run's one transaction rolled back, so nothing of it
 * committed.
 */
function lostSharedRace(error: unknown): boolean {
  const cause = (error instanceof Error ? error.cause : undefined) as
    { readonly code?: unknown; readonly message?: unknown } | undefined;
  return cause?.code === 'XX000' && cause.message === 'tuple concurrently updated';
}

/**
 * Run `apply`, and run it again from the start while it loses the shared
 * catalogue race. Any other failure, or the last attempt's, is thrown as it
 * came.
 */
async function retryOnSharedRace<T>(apply: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another, never two at once
      return await apply();
    } catch (error) {
      if (attempt >= SHARED_RACE_ATTEMPTS || !lostSharedRace(error)) throw error;
    }
    // Jittered, so two runs that lost to each other do not meet again in step.
    // oxlint-disable-next-line no-await-in-loop -- the next attempt follows this pause
    await pause(50 * attempt + Math.floor(Math.random() * 100));
  }
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
  options: MigrateOptions = {},
): Promise<MigrationOutcome> {
  const timing = lockTiming(options);
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another, never two at once
      return await retryOnSharedRace(
        async () => await applyOnce(admin, migrations, timing.timeoutMs),
      );
    } catch (error) {
      if (!(error instanceof LockWaitTimedOut)) throw error;
      if (attempt >= timing.attempts) {
        throw new MigrationLockTimeout(
          // oxlint-disable-next-line no-await-in-loop -- the last look, after the last attempt
          await busySessions(admin.execute),
          error.pending,
          timing,
          error.startedAt,
        );
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- the next attempt follows this pause
    await pause(timing.pauseMs);
  }
}

/** An attempt that rolled back whole because a lock wait passed `lock_timeout`. */
class LockWaitTimedOut extends Error {
  readonly pending: readonly string[];
  readonly startedAt: string;

  constructor(pending: readonly string[], startedAt: string, cause: unknown) {
    super('migrate: a lock wait timed out; the attempt rolled back', { cause });
    this.pending = pending;
    this.startedAt = startedAt;
  }
}

/**
 * Whether a lock wait passed `lock_timeout` (55P03, lock_not_available),
 * raised by the runner's own statement or, wrapped, by a file's.
 */
function timedOutOnALock(error: unknown): boolean {
  return (
    sqlState(error) === '55P03' ||
    sqlState(error instanceof Error ? error.cause : undefined) === '55P03'
  );
}

function sqlState(error: unknown): unknown {
  return (error as { readonly code?: unknown } | null | undefined)?.code;
}

/** One attempt: the ledger read, every check, and the one transaction. */
async function applyOnce(
  admin: AdminConnection,
  migrations: readonly Migration[],
  lockTimeoutMs: number,
): Promise<MigrationOutcome> {
  refuseOutsideATransaction(migrations);
  const ledger = await readLedger(admin);
  const { pending, alreadyApplied } = splitByLedger(ledger, migrations);
  // Nothing pending is nothing to protect, so an up-to-date database with the
  // application running passes.
  if (pending.length === 0) return { applied: [], alreadyApplied };
  const names = pending.map((migration) => migration.version);
  // The one transaction rolls a failure back to where the run started, which
  // is the ledger's last version, whatever list the caller passed.
  const last = [...(ledger?.keys() ?? [])].toSorted().at(-1);
  const startedAt = last === undefined ? 'without any migration' : `at ${last}`;

  // Every look is inside the transaction, after its locks: once they are
  // held, then before each file, and once more before the commit, so a
  // session that gets busy after the first look still refuses the run, and
  // the whole run rolls back. A look before the locks would refuse a lock
  // holder at once, where the bounded wait and its retries give a transient
  // one time to finish.
  await refuseIfBlind(admin.execute, names, startedAt);
  try {
    await admin.transaction(
      async (execute) => {
        const opened = await transactionId(execute);
        await lockFirst(execute, lockTimeoutMs).catch((cause: unknown) => {
          throw new Error(
            `migrate: could not lock the tables in ops and public before the run. Nothing was ` +
              `applied; the database is still ${startedAt}.`,
            { cause },
          );
        });
        // Migrations are ordered and each one may depend on the last, so they are
        // applied one at a time on purpose. The same goes for the statements
        // inside one migration. `Promise.all` here would apply a schema in an
        // order nobody wrote.
        for (const migration of pending) {
          // oxlint-disable-next-line no-await-in-loop
          await refuseIfBusy(execute, names, startedAt);
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
            // The tripwire. The guard and the backstop are readings; this is
            // the server's word that the run's one transaction is still open.
            // oxlint-disable-next-line no-await-in-loop
            if ((await transactionId(execute)) !== opened) {
              throw new Error(
                `migrate: ${migration.version} ended the run's transaction on: ` +
                  `${statement.slice(0, 200)}. The run stopped there. Work before it in this run ` +
                  `may be committed, so read ops.schema_migrations and the schema before running again.`,
              );
            }
          }
          // oxlint-disable-next-line no-await-in-loop
          await execute(`insert into ops.schema_migrations (version, checksum) values ($1, $2)`, [
            migration.version,
            migration.checksum,
          ]);
        }
        await refuseIfBusy(execute, names, startedAt);
      },
      { oneCommandEach: true },
    );
  } catch (error) {
    if (timedOutOnALock(error)) throw new LockWaitTimedOut(names, startedAt, error);
    throw error;
  }
  return { applied: names, alreadyApplied };
}
