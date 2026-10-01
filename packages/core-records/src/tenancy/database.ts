// SPDX-License-Identifier: AGPL-3.0-only
//
// The tenancy wrapper: the one way the application reaches Postgres.
//
// Every call opens a transaction, sets the business inside it, does its work
// and commits. The setting is set with SET LOCAL — `set_config(..., true)` is
// the parameterised spelling of it — because poolers share database roles
// across connections, and a setting that outlives its transaction is handed
// to whoever gets the connection next. That is the whole reason the wrapper
// exists rather than a `setBusiness()` a caller is trusted to remember.
//
// There is no way to obtain a query handle outside `withBusiness`. A caller
// holding a `TenantQuery` is, by construction, inside a transaction whose
// business is already set.

import postgres from 'postgres';
import { createStatementLog, type StatementLog } from './statements.ts';
import { isUuid } from './ids.ts';
import {
  handleOn,
  type BusinessId,
  type TenantQuery,
  type TransactionQuery,
} from './transaction.ts';

export type { BusinessId, TenantQuery, TransactionQuery } from './transaction.ts';

export function isBusinessId(value: string): value is BusinessId {
  return isUuid(value);
}

/**
 * The one advisory lock in the product: a transaction-scoped lock on `key`,
 * released at commit or rollback like a row lock. Every caller builds a key
 * that names its business, so two businesses never wait on each other.
 *
 * Where it sits in the lock order is `core-runtime/src/locks.ts`: the chain
 * class is `acquire`'s own first class, and the command layer's keys (the
 * placement and sibling locks) come before anything `acquire` takes. Nothing
 * else in `packages/` or `apps/` spells the SQL (`tests/runtime/cq-8.test.ts`).
 */
export async function advisoryLock(tx: Pick<TenantQuery, 'query'>, key: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

export interface Connection {
  /** Everything this connection has sent, for the no-runtime-DDL assertion. */
  readonly log: StatementLog;
  close(): Promise<void>;
}

/** What the application gets. There is no way through it but the wrapper. */
export interface Database extends Connection {
  withBusiness<T>(businessId: BusinessId, run: (tx: TransactionQuery) => Promise<T>): Promise<T>;
}

/**
 * What migrations and the harness get, and the application never does. It is a
 * separate type rather than a method on `Database` so that "the application
 * cannot issue a statement outside the wrapper" is a fact about the types
 * rather than a rule someone has to keep.
 */
export interface AdminConnection extends Connection {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
  transaction<T>(
    run: (execute: AdminConnection['execute']) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export interface TransactionOptions {
  /**
   * Send each text over the extended query protocol, so the server refuses
   * one that holds more than one command ("cannot insert multiple commands
   * into a prepared statement") rather than running them all. The migration
   * runner sets it, so a statement its reading of SQL got wrong cannot end
   * its one transaction (FR10-GUARD). Harness fixtures that send several
   * commands in one string leave it off.
   */
  readonly oneCommandEach?: boolean;
}

export interface DatabaseOptions {
  /** What to label this connection's statements: `runtime`, `migration`, `harness`. */
  readonly source?: string;
  /** Share one log across connections when the run wants a single trail. */
  readonly log?: StatementLog;
  readonly max?: number;
}

export function open(
  url: string,
  options: DatabaseOptions,
): { sql: postgres.Sql; log: StatementLog } {
  const log = options.log ?? createStatementLog();
  const source = options.source ?? 'runtime';
  const sql = postgres(url, {
    max: options.max ?? 1,
    prepare: false,
    onnotice: () => {},
    debug: (_connection: number, query: string) => {
      log.record(source, query);
    },
    // The log reads a plain string as standard_conforming_strings = on does.
    // Every connection starts with it on, so a database or role default of
    // off does not apply, and RESET comes back to on. The server reports each
    // change of it however it was made (SET, SET LOCAL, set_config, a function
    // body), and a change away from on is recorded as a point the log cannot
    // read past.
    connection: { standard_conforming_strings: 'on' },
    onparameter: (key: string, value: unknown) => {
      if (key === 'standard_conforming_strings' && value !== 'on') {
        log.unreadable(source, `standard_conforming_strings = ${String(value)}`);
      }
    },
  });
  // postgres.js puts a URL's query parameters into the startup packet after
  // `connection` above, so one naming the setting, in any case and with any
  // value or none, would have its way. The wrapper
  // owns the setting instead of refusing the URL: it rewrites the parameters
  // postgres.js resolved, which every connection of this handle shares and
  // reads when it builds its startup packet (connection.js, StartupMessage),
  // to hold exactly one `on`. Nothing has connected yet; postgres.js connects
  // on the first query. An `options=-c ...` switch is no conflict: the server
  // applies the named parameter after it.
  const startup = sql.options.connection as Record<string, unknown>;
  for (const key of Object.keys(startup)) {
    if (key.toLowerCase() === 'standard_conforming_strings') delete startup[key];
  }
  startup['standard_conforming_strings'] = 'on';
  return { sql, log };
}

/**
 * Postgres.js sends a text with no parameters over the simple query protocol,
 * which runs every command in it (`unsafe` sets `simple: args.length === 0`,
 * src/index.js in 3.4.9). `simple: false` forces the extended protocol, one
 * command per send. The package's types omit `simple`, which its `unsafe`
 * reads, hence the cast.
 */
const EXTENDED_PROTOCOL = { prepare: false, simple: false } as postgres.UnsafeQueryOptions;

async function sendUnsafe<Row>(
  handle: { unsafe: postgres.Sql['unsafe'] },
  text: string,
  parameters: readonly unknown[],
  oneCommand = false,
): Promise<readonly Row[]> {
  const rows = oneCommand
    ? await handle.unsafe(text, parameters as never[], EXTENDED_PROTOCOL)
    : await handle.unsafe(text, parameters as never[]);
  return rows as unknown as readonly Row[];
}

/**
 * The wrapper itself, over one pool handle. It is a function of the handle so
 * that the pool a crossover test watches runs the same `withBusiness` the
 * application does, rather than a second copy of it that could drift.
 */
function withBusinessOn(sql: postgres.Sql): Database['withBusiness'] {
  return async function withBusiness<T>(
    businessId: BusinessId,
    run: (tx: TransactionQuery) => Promise<T>,
  ): Promise<T> {
    if (!isBusinessId(businessId)) {
      throw new Error(`withBusiness: ${JSON.stringify(businessId)} is not a business identifier`);
    }
    // `begin` unwraps a promise-shaped result in its own types; the cast
    // restores the caller's type and nothing else.
    return (await sql.begin(async (tx) => {
      // Inside the transaction, and nowhere else. `true` is the is_local
      // argument, which is what makes this SET LOCAL rather than SET.
      await tx.unsafe(`select set_config('app.business_id', $1, true)`, [businessId]);
      return await run(handleOn(tx, businessId));
    })) as T;
  };
}

export function connect(url: string, options: DatabaseOptions = {}): Database {
  const { sql, log } = open(url, options);

  return {
    log,
    withBusiness: withBusinessOn(sql),
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

/**
 * A session connection that can only listen (T2f): LISTEN is a session verb,
 * outside `withBusiness`, and this handle sends nothing else. postgres.js
 * listens again after a reconnect and calls `onListening` each time. Hosted,
 * it needs a direct or session-mode URL: LISTEN fails through a
 * transaction-mode pooler.
 */
export interface Listener extends Connection {
  listen(
    channel: string,
    onPayload: (payload: string) => void,
    onListening: () => void,
  ): Promise<void>;
}

export function connectListener(url: string, options: DatabaseOptions = {}): Listener {
  const { sql, log } = open(url, { source: 'listener', ...options });

  return {
    log,
    async listen(channel, onPayload, onListening): Promise<void> {
      await sql.listen(channel, onPayload, onListening);
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

/**
 * The same pool, plus the one thing the application is deliberately denied: a
 * statement on the pool's connection outside any `withBusiness` transaction.
 *
 * This exists for one proof and should be used for no other. The tenancy law
 * is about what a *reused physical backend* carries from one tenant's
 * transaction to the next, and the next transaction's own `SET LOCAL` writes
 * over whatever was left behind, so asking inside it can only ever return the
 * right answer. Between the two transactions is the only place the question
 * can be asked, and `Database` has no door there — by design, which is why
 * this is a separate factory with a name that says what it is for rather than
 * a method someone could reach for by accident.
 *
 * `connect` is what the application gets, and it returns a `Database` with no
 * such door on it.
 */
export interface ObservedPool extends Database {
  /**
   * One statement on the pool's connection with no transaction open and no
   * tenant set. With `max: 1` this is the backend the wrapper just used.
   */
  betweenTransactions<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

export function connectObserved(url: string, options: DatabaseOptions = {}): ObservedPool {
  const { sql, log } = open(url, options);

  return {
    log,
    withBusiness: withBusinessOn(sql),
    async betweenTransactions<Row>(
      text: string,
      parameters: readonly unknown[] = [],
    ): Promise<readonly Row[]> {
      return await sendUnsafe<Row>(sql, text, parameters);
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

export function connectAsAdmin(url: string, options: DatabaseOptions = {}): AdminConnection {
  const { sql, log } = open(url, { source: 'admin', ...options });

  return {
    log,
    async execute<Row>(text: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
      return await sendUnsafe<Row>(sql, text, parameters);
    },
    async transaction<T>(
      body: (execute: AdminConnection['execute']) => Promise<T>,
      transactionOptions: TransactionOptions = {},
    ): Promise<T> {
      const oneCommand = transactionOptions.oneCommandEach === true;
      return (await sql.begin(
        async (tx) =>
          await body(
            async <Row>(text: string, parameters: readonly unknown[] = []) =>
              await sendUnsafe<Row>(tx, text, parameters, oneCommand),
          ),
      )) as T;
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
