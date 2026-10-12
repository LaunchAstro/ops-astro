// SPDX-License-Identifier: AGPL-3.0-only
//
// Two wrappers around a database for the crash and race proofs: one whose
// chosen statements raise, so a transaction dies at a named step, and one that
// keeps each transaction open after its work is done until the test lets it
// commit, so a second connection can try its change at that step.

import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { gate } from './lock-waits.ts';

/** The fault a failing statement raises. */
export class StatementFailed extends Error {}

/** Which statement raises: its text and parameters as sent. */
export type FailWhen = (text: string, parameters: readonly unknown[]) => boolean;

/** `tx`, with the statements `when` names raising. */
function failingTx(tx: TenantQuery, when: FailWhen, spend: () => boolean): TenantQuery {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
      return async (text: string, parameters: readonly unknown[] = []) => {
        if (when(text, parameters) && spend()) {
          throw new StatementFailed(`the statement failed: ${text.slice(0, 60)}`);
        }
        return await target.query(text, parameters);
      };
    },
  });
}

/**
 * `database`, with the first `times` statements `when` names raising (every
 * one by default), in whichever transaction sends them.
 */
export function failingStatements(
  database: Database,
  when: FailWhen,
  times: number = Number.POSITIVE_INFINITY,
): Database {
  let left = times;
  const spend = (): boolean => {
    if (left <= 0) return false;
    left -= 1;
    return true;
  };
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'withBusiness') return Reflect.get(target, property, receiver) as unknown;
      return async <T>(
        businessId: Parameters<Database['withBusiness']>[0],
        run: (tx: TenantQuery) => Promise<T>,
      ): Promise<T> =>
        await target.withBusiness(businessId, async (tx) => await run(failingTx(tx, when, spend)));
    },
  });
}

/** Whether a statement takes the advisory lock on a key starting `prefix`. */
export const locksKey =
  (prefix: string): FailWhen =>
  (text, parameters) =>
    text.includes('pg_advisory_xact_lock') &&
    typeof parameters[0] === 'string' &&
    parameters[0].startsWith(prefix);

/** Whether a statement inserts into `table` (schema-qualified or not). */
export const insertsInto =
  (table: string): FailWhen =>
  (text) =>
    new RegExp(String.raw`insert\s+into\s+(?:public\.)?${table}\b`, 'iu').test(text);

export interface HeldOpen {
  readonly database: Database;
  /** Resolves once the first transaction has done its work and waits to commit. */
  readonly returned: Promise<void>;
  /** Lets that transaction commit. */
  readonly commit: () => void;
}

/**
 * `base`, with its first transaction kept open after its work returns, before
 * it commits, until `commit` is called. Later transactions run straight through.
 */
export function heldOpen(base: Database): HeldOpen {
  const returned = gate();
  const committing = gate();
  let first = true;
  const database: Database = {
    log: base.log,
    close: async () => await base.close(),
    withBusiness: async (id, run) =>
      await base.withBusiness(id, async (tx) => {
        const answer = await run(tx);
        if (first) {
          first = false;
          returned.release();
          await committing.promise;
        }
        return answer;
      }),
  };
  return { database, returned: returned.promise, commit: committing.release };
}
