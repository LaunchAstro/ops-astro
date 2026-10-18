// SPDX-License-Identifier: AGPL-3.0-only
//
// #1774, from Sol's review of PR #1865 (head d3c33a2): hostile connection
// loss. A transaction whose backend ends with statements in flight and many
// more queued in begin()'s own queue refuses every one, and a savepoint left
// running after its transaction's connection ended cannot write into the next
// business's session once the pool reconnects.

import { describe, it, expect } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const ALPHA = '00000000-0000-4000-8000-00000000000a';
const BETA = '00000000-0000-4000-8000-00000000000b';
const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => String(e.code),
  );
async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('pending statements did not settle')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function queuedStatementsRefused(kind: 'runtime' | 'admin'): Promise<void> {
  const db = await createFreshDatabase({ part: 'lost_queue' });
  const operator = connectAsAdmin(serverUrl as string);
  const ready = latch();
  let pid = 0;
  let statements!: Promise<string[]>;
  const run = async (execute: (sql: string, args?: readonly unknown[]) => Promise<unknown>) => {
    const rows = (await execute('select pg_backend_pid() as pid')) as { pid: number }[];
    pid = rows[0]!.pid;
    // The parameterised first query fills the driver while waiting for its describe response.
    // The remaining statements enter begin's private queue before the server kills the backend.
    statements = Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        outcome(execute('select pg_sleep($1)', [i === 0 ? 30 : 0])),
      ),
    );
    ready.open();
    await statements;
  };
  try {
    const call = outcome(
      kind === 'runtime'
        ? db.app.withBusiness(ALPHA, (tx) => run(tx.query))
        : db.admin.transaction(run),
    );
    await ready.wait;
    await sleep(100);
    await operator.execute('select pg_terminate_backend($1)', [pid]);
    expect(await bounded(call)).toBe('CONNECTION_CLOSED');
    expect(await bounded(statements)).toEqual(
      Array.from({ length: 150 }, () => 'CONNECTION_CLOSED'),
    );
    const rows = await db.app.withBusiness(BETA, (tx) =>
      tx.query<{ business: string }>("select current_setting('app.business_id') as business"),
    );
    expect(rows[0]?.business).toBe(BETA);
  } finally {
    await db.drop();
    await operator.close();
  }
}

async function staleSavepointKeptOut(): Promise<void> {
  const db = await createFreshDatabase({ part: 'lost_savepoint' });
  const outerEnded = latch();
  const betaInside = latch();
  const staleDone = latch();
  let stale!: Promise<string>;
  try {
    const alpha = outcome(
      db.app.withBusiness(ALPHA, (tx) =>
        tx.savepoint(async (inner) => {
          const [row] = await inner.query<{ pid: number }>('select pg_backend_pid() as pid');
          await db.admin.execute('select pg_terminate_backend($1)', [row!.pid]);
          await outerEnded.wait;
          await betaInside.wait;
          stale = outcome(inner.query("select set_config('app.stale', 'alpha', true)"));
          await stale;
          staleDone.open();
        }),
      ),
    );
    await alpha;
    outerEnded.open();
    await db.app.withBusiness(BETA, async (tx) => {
      await tx.query("select set_config('app.stale', 'beta', true)");
      betaInside.open();
      await bounded(staleDone.wait);
      await sleep(200);
      const [row] = await tx.query<{ stale: string; business: string }>(
        "select current_setting('app.stale') as stale, current_setting('app.business_id') as business",
      );
      expect(row).toEqual({ stale: 'beta', business: BETA });
    });
    expect(await stale).toBe('CONNECTION_CLOSED');
  } finally {
    await db.drop();
  }
}

describe.skipIf(serverUrl === undefined)(
  'a lost connection with statements queued or a savepoint running',
  () => {
    for (const kind of ['runtime', 'admin'] as const) {
      it(
        `${kind}: in-flight and queued statements are refused and the next business is untouched`,
        () => queuedStatementsRefused(kind),
        60000,
      );
    }
    it(
      'a stale savepoint cannot write into the next business after a reconnect',
      () => staleSavepointKeptOut(),
      60000,
    );
  },
);
