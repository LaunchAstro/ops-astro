// SPDX-License-Identifier: AGPL-3.0-only
//
// What the factor acts' ending-key races (C52-A on the factor path) are built
// from: a backend's pid, a wait for backends parked behind one
// (`pg_blocking_pids`), a provider held at its first call, and the act's pool
// with one stop at a named statement after its audit event.

import { setTimeout as delay } from 'node:timers/promises';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import type {
  AdminConnection,
  Database,
  TenantQuery,
  TransactionQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { gate } from '../support/lock-waits.ts';

export async function backendPid(tx: TenantQuery): Promise<number> {
  const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
  return row?.pid ?? 0;
}

/**
 * Waits until `count` backends of this database wait behind `holder`
 * (`pg_blocking_pids`). Throws when `settled` answers first: what should have
 * waited finished without waiting.
 */
export async function blockedBy(
  admin: Pick<AdminConnection, 'execute'>,
  holder: number,
  settled: () => boolean,
  what: string,
  count = 1,
): Promise<void> {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    if (settled()) throw new Error(`${what} finished without waiting behind backend ${holder}`);
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and $1::int = any (pg_blocking_pids(pid))`,
      [holder],
    );
    if ((row?.n ?? 0) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`${what} never waited behind backend ${holder}`);
}

/** The provider, its first enrol or verify call held until `goOn`. */
export function pausedAtProvider(inner: FactorProvider): {
  readonly to: FactorProvider;
  readonly reached: Promise<void>;
  readonly goOn: () => void;
} {
  const reached = gate();
  const going = gate();
  let first = true;
  const pause = async () => {
    if (!first) return;
    first = false;
    reached.release();
    await going.promise;
  };
  return {
    to: {
      ...inner,
      enrol: async (...args) => {
        await pause();
        return await inner.enrol(...args);
      },
      verify: async (...args) => {
        await pause();
        return await inner.verify(...args);
      },
    },
    reached: reached.promise,
    goOn: going.release,
  };
}

export interface Stopped {
  readonly database: Database;
  /** The stopped transaction's backend, once it is stopped. */
  readonly stopped: Promise<number>;
  readonly release: () => void;
}

/**
 * The act's pool with one stop: in a transaction that wrote its audit event,
 * the first statement `at` matches waits there for `release`, after telling
 * the test its backend. Every statement is the real one; only the wait is added.
 */
export function stopAt(
  inner: Database,
  at: (text: string, rows: readonly unknown[]) => boolean,
): Stopped {
  let reached!: (pid: number) => void;
  const stopped = new Promise<number>((resolve) => {
    reached = resolve;
  });
  const released = gate();
  let armed = true;
  const stopping = (tx: TransactionQuery): TransactionQuery => {
    let audited = false;
    return {
      businessId: tx.businessId,
      savepoint: tx.savepoint,
      async query<Row>(text: string, parameters?: readonly unknown[]) {
        const rows = await tx.query<Row>(text, parameters);
        if (text.includes('insert into audit_events')) audited = true;
        if (armed && audited && at(text, rows)) {
          armed = false;
          reached(await backendPid(tx));
          await released.promise;
        }
        return rows;
      },
    };
  };
  return {
    database: {
      log: inner.log,
      close: async () => await inner.close(),
      withBusiness: async (businessId, run) =>
        await inner.withBusiness(businessId, async (tx) => await run(stopping(tx))),
    },
    stopped,
    release: released.release,
  };
}

/** The act's last read of its session's endings, answering live. */
export const lastSessionRead = (text: string, rows: readonly unknown[]): boolean =>
  text.includes('ended_provider_sessions') &&
  (rows[0] as { readonly ended?: unknown } | undefined)?.ended === false;

/** The act undone: the statement that takes back what it did. */
export const undone = (text: string): boolean => text.startsWith('rollback to savepoint');
