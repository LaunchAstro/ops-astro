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

import type postgres from 'postgres';
import { open, RUNTIME_IDLE_SECONDS, type DatabaseOptions } from './driver.ts';
import type { StatementLog } from './statements.ts';
import { isUuid } from './ids.ts';
import { checkDeferred, deadlineOn, timeLeft, untilDeadline, type Deadline } from './deadline.ts';
import {
  handleOn,
  type BusinessId,
  type TenantQuery,
  type TransactionQuery,
} from './transaction.ts';

export type { BusinessId, TenantQuery, TransactionQuery } from './transaction.ts';
export { open, RUNTIME_IDLE_SECONDS, type DatabaseOptions } from './driver.ts';

export function isBusinessId(value: string): value is BusinessId {
  return isUuid(value);
}

/**
 * The one advisory lock in the product: a transaction-scoped lock on `key`,
 * released at commit or rollback like a row lock. Every key names its business,
 * so two businesses never wait on each other, except C59's two installation-wide keys,
 * `second-factor-codes:` and `second-factor-subject:` with a login's subject digest, so
 * its businesses do: each is taken first in its transaction, before any row or chain lock.
 *
 * Where it sits in the lock order is `core-runtime/src/locks.ts`: the chain
 * class is `acquire`'s own first class, and the command layer's keys (the
 * operation identity's door first, then the placement and sibling locks) come
 * before anything `acquire` takes. Nothing
 * else in `packages/` or `apps/` spells the SQL (`tests/runtime/cq-8.test.ts`).
 *
 * `shared` is the same key's reader mode: readers hold it together and only
 * the exclusive mode waits on them (the settings install lock,
 * `lockSettingsInstall`).
 */
export async function advisoryLock(
  tx: Pick<TenantQuery, 'query'>,
  key: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<void> {
  const shared = mode === 'shared' ? '_shared' : '';
  await tx.query(`select pg_advisory_xact_lock${shared}(hashtextextended($1, 0))`, [key]);
}

export interface Connection {
  /** What this connection has sent, for the no-runtime-DDL assertion (`DatabaseOptions.log`). */
  readonly log: StatementLog;
  close(): Promise<void>;
}

/** What the application gets. There is no way through it but the wrapper. */
export interface Database extends Connection {
  withBusiness<T>(
    businessId: BusinessId,
    run: (tx: TransactionQuery) => Promise<T>,
    options?: TransactionDeadline,
  ): Promise<T>;
}

/** A transaction that ends by a deadline (`deadline.ts`). */
export interface TransactionDeadline {
  /**
   * When, in `Date.now()` milliseconds, the transaction must be over: none
   * begins after it, no statement is sent after it, and the statement running
   * at it is cancelled, which rolls the transaction back. Unset, no deadline.
   */
  readonly deadline?: number;
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

export interface TransactionOptions extends TransactionDeadline {
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
  deadline?: Deadline,
): Promise<readonly Row[]> {
  const rows = await untilDeadline(handle, deadline, () =>
    oneCommand
      ? handle.unsafe(text, parameters as never[], EXTENDED_PROTOCOL)
      : handle.unsafe(text, parameters as never[]),
  );
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
    { deadline }: TransactionDeadline = {},
  ): Promise<T> {
    if (!isBusinessId(businessId)) {
      throw new Error(`withBusiness: ${JSON.stringify(businessId)} is not a business identifier`);
    }
    if (deadline !== undefined) timeLeft(deadline);
    // One spelling of the id, the lower case Postgres prints, so a key built
    // from `tx.businessId` (a limiter's lock) is one key in either letter case.
    const business = businessId.toLowerCase() as BusinessId;
    // Read committed whatever the login's or database's default, so a count
    // read after a lock sees what the lock's last holder committed (`hasRoom`).
    // `begin` unwraps a promise-shaped result in its own types; the cast
    // restores the caller's type and nothing else.
    return (await sql.begin('isolation level read committed', async (tx) => {
      // Inside the transaction, and nowhere else. `true` is the is_local
      // argument, which is what makes this SET LOCAL rather than SET.
      await tx.unsafe(`select set_config('app.business_id', $1, true)`, [business]);
      if (deadline === undefined) return await run(handleOn(tx, business));
      const handle = handleOn(tx, business, await deadlineOn(tx, deadline));
      const result = await run(handle);
      await checkDeferred(handle.query);
      return result;
    })) as T;
  };
}

/**
 * The runtime pool. Every statement on it is inside a `withBusiness`
 * transaction, so no session state outlives one, and an idle connection
 * closes after `RUNTIME_IDLE_SECONDS` unless the caller says otherwise.
 */
export function connect(url: string, options: DatabaseOptions = {}): Database {
  const { sql, log } = open(url, { idleSeconds: RUNTIME_IDLE_SECONDS, ...options });

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
      const { deadline } = transactionOptions;
      if (deadline !== undefined) timeLeft(deadline);
      return (await sql.begin(async (tx) => {
        const limited = deadline === undefined ? undefined : await deadlineOn(tx, deadline);
        return await body(
          async <Row>(text: string, parameters: readonly unknown[] = []) =>
            await sendUnsafe<Row>(tx, text, parameters, oneCommand, limited),
        );
      })) as T;
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
