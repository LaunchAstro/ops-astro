// SPDX-License-Identifier: AGPL-3.0-only
//
// One broken connection, written as the database owner. Connection rows are
// written by the connector's setup (MP-13-5) and the broker's sync (AW-01),
// neither built, so a suite that needs a connection to repair seeds one here.

import { randomUUID } from 'node:crypto';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';

export interface OwnerConnection {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

export async function seedBrokenConnection(
  admin: OwnerConnection,
  business: string,
  label = 'a broken source',
): Promise<string> {
  const id = randomUUID();
  await admin.execute(
    `insert into public.connections (business_id, id, connector_key, label, status, failure_class)
     values ($1, $2, 'seeded', $3, 'broken', 'auth_expired')`,
    [business, id, label],
  );
  return id;
}

/**
 * The same database, its transactions paused once after the first statement
 * whose text holds `statement`: a race case lets a second request (on another
 * connection) land at exactly that point, then lets the first go on.
 */
export function pausingAfter(
  database: Database,
  statement: string,
  paused: () => Promise<void>,
): Database {
  const pausing = (tx: TransactionQuery, state: { met: boolean }): TransactionQuery => ({
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]) {
      const rows = await tx.query<Row>(text, parameters);
      if (!state.met && text.includes(statement)) {
        state.met = true;
        await paused();
      }
      return rows;
    },
    async savepoint(work) {
      return await tx.savepoint(async (inner) => {
        await work(pausing(inner, state));
      });
    },
  });
  return {
    log: database.log,
    close: async () => {
      await database.close();
    },
    withBusiness: async (businessId, run) =>
      await database.withBusiness(businessId, async (tx) => await run(pausing(tx, { met: false }))),
  };
}
