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

/** A business identifier. Checked before it reaches the server, never interpolated. */
export type BusinessId = string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isBusinessId(value: string): value is BusinessId {
  return UUID.test(value);
}

export interface TenantQuery {
  readonly businessId: BusinessId;
  /** Run one statement inside the open transaction. Parameters are bound, never spliced. */
  query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

export interface Connection {
  /** Everything this connection has sent, for the no-runtime-DDL assertion. */
  readonly log: StatementLog;
  close(): Promise<void>;
}

/** What the application gets. There is no way through it but the wrapper. */
export interface Database extends Connection {
  withBusiness<T>(businessId: BusinessId, run: (tx: TenantQuery) => Promise<T>): Promise<T>;
}

/**
 * What migrations and the harness get, and the application never does. It is a
 * separate type rather than a method on `Database` so that "the application
 * cannot issue a statement outside the wrapper" is a fact about the types
 * rather than a rule someone has to keep.
 */
export interface AdminConnection extends Connection {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
  transaction<T>(run: (execute: AdminConnection['execute']) => Promise<T>): Promise<T>;
}

export interface DatabaseOptions {
  /** What to label this connection's statements: `runtime`, `migration`, `harness`. */
  readonly source?: string;
  /** Share one log across connections when the run wants a single trail. */
  readonly log?: StatementLog;
  readonly max?: number;
}

function open(url: string, options: DatabaseOptions): { sql: postgres.Sql; log: StatementLog } {
  const log = options.log ?? createStatementLog();
  const source = options.source ?? 'runtime';
  const sql = postgres(url, {
    max: options.max ?? 1,
    prepare: false,
    onnotice: () => {},
    debug: (_connection: number, query: string) => {
      log.record(source, query);
    },
  });
  return { sql, log };
}

export function connect(url: string, options: DatabaseOptions = {}): Database {
  const { sql, log } = open(url, options);

  return {
    log,

    async withBusiness<T>(
      businessId: BusinessId,
      run: (tx: TenantQuery) => Promise<T>,
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
        return await run({
          businessId,
          async query<Row>(
            text: string,
            parameters: readonly unknown[] = [],
          ): Promise<readonly Row[]> {
            const rows = await tx.unsafe(text, parameters as never[]);
            return rows as unknown as readonly Row[];
          },
        });
      })) as T;
    },

    async close(): Promise<void> {
      await sql.end();
    },
  };
}

async function sendUnsafe<Row>(
  handle: { unsafe: postgres.Sql['unsafe'] },
  text: string,
  parameters: readonly unknown[],
): Promise<readonly Row[]> {
  const rows = await handle.unsafe(text, parameters as never[]);
  return rows as unknown as readonly Row[];
}

export function connectAsAdmin(url: string, options: DatabaseOptions = {}): AdminConnection {
  const { sql, log } = open(url, { source: 'admin', ...options });

  return {
    log,
    async execute<Row>(text: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
      return await sendUnsafe<Row>(sql, text, parameters);
    },
    async transaction<T>(body: (execute: AdminConnection['execute']) => Promise<T>): Promise<T> {
      return (await sql.begin(
        async (tx) =>
          await body(
            async <Row>(text: string, parameters: readonly unknown[] = []) =>
              await sendUnsafe<Row>(tx, text, parameters),
          ),
      )) as T;
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
