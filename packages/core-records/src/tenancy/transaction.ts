// SPDX-License-Identifier: AGPL-3.0-only
//
// The handle `withBusiness` gives its caller (`database.ts`): one open
// transaction whose business is already set, and a savepoint inside it that a
// failed statement rolls back without ending the transaction.

import postgres from 'postgres';

/** A business identifier. Checked before it reaches the server, never interpolated. */
export type BusinessId = string;

export interface TenantQuery {
  readonly businessId: BusinessId;
  /** Run one statement inside the open transaction. Parameters are bound, never spliced. */
  query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

/** What `withBusiness` hands its caller: the query, and a savepoint that can fail. */
export interface TransactionQuery extends TenantQuery {
  /**
   * `work` in a savepoint of its own: `true` when it completed; `false` when a
   * statement in it failed, which rolls back to the savepoint and leaves the
   * transaction going. A raw `savepoint` statement cannot do this: postgres.js
   * fails the whole transaction on any statement error inside it (`executeCommand`
   * in core-commands), so this is the driver's own nested scope. Anything but a
   * server error is thrown on.
   */
  savepoint(work: (tx: TransactionQuery) => Promise<void>): Promise<boolean>;
}

/** The caller's handle on an open transaction, or on a savepoint inside one. */
export function handleOn(tx: postgres.TransactionSql, businessId: BusinessId): TransactionQuery {
  return {
    businessId,
    async query<Row>(text: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
      const rows = await tx.unsafe(text, parameters as never[]);
      return rows as unknown as readonly Row[];
    },
    async savepoint(work: (inner: TransactionQuery) => Promise<void>): Promise<boolean> {
      try {
        await tx.savepoint(async (inner) => {
          await work(handleOn(inner, businessId));
        });
        return true;
      } catch (error) {
        if (error instanceof postgres.PostgresError) return false;
        throw error;
      }
    },
  };
}
