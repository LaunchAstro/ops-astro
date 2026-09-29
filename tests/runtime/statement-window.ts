// SPDX-License-Identifier: AGPL-3.0-only
//
// The statements a site runs, read off a traced connection, for
// `rediscovery-pin.test.ts`. A statement is labelled by its first words and a
// digest of its whole text, and a row lock by its table; a site's window runs
// from its first unlocked discovery to the end of its recheck under the locks.

import { createHash } from 'node:crypto';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

/** Every `withBusiness` transaction a connection opened, as the statements it ran. */
export function traced(database: Database): {
  readonly database: Database;
  readonly transactions: readonly string[][];
} {
  const transactions: string[][] = [];
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'withBusiness') return Reflect.get(target, property, receiver) as unknown;
      return async <T>(
        businessId: Parameters<Database['withBusiness']>[0],
        run: (tx: TenantQuery) => Promise<T>,
      ): Promise<T> => {
        const statements: string[] = [];
        transactions.push(statements);
        return await target.withBusiness(
          businessId,
          async (tx) =>
            await run(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown;
                  return async (text: string, parameters: readonly unknown[] = []) => {
                    statements.push(text);
                    return await inner.query(text, parameters);
                  };
                },
              }),
            ),
        );
      };
    },
  });
  return { database: wrapped, transactions };
}

const normal = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();
const ROW_LOCK = /^select 1 from public\.(\w+) where business_id = \$1 and id = \$2 for update$/u;

function label(text: string): string {
  const flat = normal(text);
  const lock = ROW_LOCK.exec(flat);
  if (lock !== null) return `lock ${lock[1]}`;
  if (flat.includes('pg_advisory_xact_lock')) return 'lock chain';
  const digest = createHash('sha256').update(flat).digest('hex').slice(0, 8);
  return `${flat.slice(0, 48)} #${digest}`;
}

/**
 * The site's window: from its first unlocked discovery to the last statement
 * that repeats one run before its locks, which is the end of its recheck.
 */
export function windowOf(transactions: readonly string[][], discovery: RegExp): readonly string[] {
  const transaction = transactions.find((each) => each.some((text) => discovery.test(text)));
  if (transaction === undefined) throw new Error(`no transaction ran ${String(discovery)}`);
  const tail = transaction.slice(transaction.findIndex((text) => discovery.test(text)));
  const locked = tail.findIndex((text) => label(text).startsWith('lock '));
  const unlocked = new Set(tail.slice(0, locked));
  const end = tail.findLastIndex((text, index) => index > locked && unlocked.has(text));
  return tail.slice(0, end + 1).map((text) => label(text));
}
