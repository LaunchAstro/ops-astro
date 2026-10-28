// SPDX-License-Identifier: AGPL-3.0-only
//
// One process per case for connection-ended-mid-transaction.test.ts. The
// failure in #1774 ends the process from a timer inside postgres.js, so the
// test cannot watch for it in its own process: it runs this script and reads
// its exit status and the one line of JSON it prints.
//
//   node connection-ended-mid-transaction.run.ts <case> <url> <server url>
//
// `url` is the connection the case opens (the application login, or the
// database's owner for the admin cases). `server url` is the superuser the
// case ends a backend with, as an operator's `pg_terminate_backend` would, and
// holds a lock with on the case's own database.

import {
  connect,
  connectAsAdmin,
  connectListener,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import { connectOutbox } from '../../packages/core-records/src/tenancy/outbox.ts';

const [kind, url, serverUrl] = process.argv.slice(2);
if (kind === undefined || url === undefined || serverUrl === undefined) {
  throw new Error('usage: <case> <url> <server url>');
}

const ALPHA = '00000000-0000-4000-8000-00000000000a' as BusinessId;
const BETA = '00000000-0000-4000-8000-00000000000b' as BusinessId;

const operator = connectAsAdmin(serverUrl, { source: 'harness' });

async function terminate(pid: number): Promise<void> {
  await operator.execute('select pg_terminate_backend($1)', [pid]);
}

/**
 * A promise's outcome as data, so a case can wait on a refusal without one
 * escaping. `addressed` says whether a refusal's message names the server it
 * lost, as postgres.js's own connection errors do.
 */
function settled(
  promise: Promise<unknown>,
): Promise<{ ok: boolean; code?: string; addressed?: boolean }> {
  const server = new URL(url as string);
  return promise.then(
    () => ({ ok: true }),
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return {
        ok: false,
        code: String(code),
        addressed: String(message).endsWith(`${server.hostname}:${server.port || '5432'}`),
      };
    },
  );
}

/** A promise a case opens by hand once it has seen a step happen. */
function latch(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Some turns of the event loop, so a write postgres.js put off with setImmediate has run. */
const turns = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 200);
  });

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The backend of an outbox append that is waiting on the case's lock. */
async function lockWaiter(
  execute: <R>(text: string) => Promise<readonly R[]>,
  tries: number,
): Promise<number> {
  const [row] = await execute<{ pid: number }>(
    `select pid from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike 'insert into ops.api_events%'`,
  );
  if (row !== undefined) return row.pid;
  if (tries === 0) throw new Error('the append never waited on the lock');
  await turns();
  return lockWaiter(execute, tries - 1);
}

const cases: Record<string, () => Promise<Record<string, unknown>>> = {
  /**
   * The runtime pool. The transaction's backend ends; the caller's own next
   * statement on it, and the rollback postgres.js sends when that one fails,
   * go to a connection that has no socket.
   */
  async runtime() {
    const db = connect(url, { max: 1 });
    const callEnded = latch();
    let statement: { ok: boolean; code?: string } | undefined;
    const call = db.withBusiness(ALPHA, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      await terminate(Number(row?.pid));
      await callEnded.wait;
      const next = tx.query('select 1');
      statement = await settled(next);
      await next;
    });
    const outcome = settled(call).finally(callEnded.open);
    const caller = await within(outcome, 5_000, 'the transaction');
    await turns();
    const after = await settled(db.withBusiness(BETA, (tx) => tx.query('select 1')));
    await db.close();
    return { caller, statement, after };
  },

  /**
   * The runtime pool after it has reconnected. A transaction whose backend
   * ended is still running when the pool hands a new session to another
   * business's transaction. Nothing the first one sends afterwards, its
   * statements or the rollback or commit postgres.js adds, may reach that
   * session.
   */
  async reconnected() {
    const db = connect(url, { max: 1 });
    const callEnded = latch();
    const betaInside = latch();
    const alphaFinished = latch();
    let statement: { ok: boolean; code?: string } | undefined;

    const alpha = db.withBusiness(ALPHA, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      await terminate(Number(row?.pid));
      await callEnded.wait;
      await betaInside.wait;
      statement = await settled(tx.query(`select set_config('app.stale', 'alpha', true)`));
      // postgres.js commits once this returns; give that its turns too.
      setTimeout(alphaFinished.open, 200);
      return 'alpha finished';
    });
    const alphaOutcome = settled(alpha).finally(callEnded.open);

    await callEnded.wait;
    const beta = db.withBusiness(BETA, async (tx) => {
      await tx.query(`select set_config('app.stale', 'beta', true)`);
      betaInside.open();
      await alphaFinished.wait;
      const [row] = await tx.query<{ stale: string; business: string }>(
        `select current_setting('app.stale') as stale,
                current_setting('app.business_id') as business`,
      );
      return row;
    });
    const betaOutcome = await within(
      beta.then(
        (row) => ({ ok: true, row }),
        (error: unknown) => ({ ok: false, code: String((error as { code?: unknown }).code) }),
      ),
      5_000,
      'the second transaction',
    );
    await db.close();
    return { caller: await alphaOutcome, statement, beta: betaOutcome };
  },

  /** The admin connection's transaction, which migrations and the harness use. */
  async admin() {
    const admin = connectAsAdmin(url);
    const callEnded = latch();
    let statement: { ok: boolean; code?: string } | undefined;
    const call = admin.transaction(async (execute) => {
      const [row] = await execute<{ pid: number }>('select pg_backend_pid() as pid');
      await terminate(Number(row?.pid));
      await callEnded.wait;
      const next = execute('select 1');
      statement = await settled(next);
      await next;
    });
    const outcome = settled(call).finally(callEnded.open);
    const caller = await within(outcome, 5_000, 'the transaction');
    await turns();
    const after = await settled(admin.execute('select 1'));
    await admin.close();
    return { caller, statement, after };
  },

  /**
   * The admin connection with a statement in flight when its backend ends.
   * The server's own error for that statement arrives before the socket
   * closes; nothing of the ended session may be left behind, so the handle
   * still ends without sending anything more.
   */
  async inFlight() {
    const admin = connectAsAdmin(url);
    const [row] = await admin.execute<{ pid: number }>('select pg_backend_pid() as pid');
    const sleeping = settled(admin.execute('select pg_sleep(30)'));
    await turns();
    await terminate(Number(row?.pid));
    const caller = await within(sleeping, 5_000, 'the statement');
    const ended = await settled(within(admin.close(), 5_000, 'ending the handle'));
    return { caller, ended };
  },

  /**
   * The API's outbox: one insert outside any transaction. The append waits on
   * a lock the case holds, its backend ends while it waits, and the outbox
   * appends again on a new session.
   */
  async outbox() {
    const outbox = connectOutbox(url);
    const signal = { kind: 'sign-in-failed', scope: '', weight: 1 };
    await outbox.append(signal);
    const superuser = new URL(serverUrl as string);
    superuser.pathname = new URL(url).pathname;
    const holder = connectAsAdmin(superuser.toString(), { source: 'harness' });
    let caller: { ok: boolean; code?: string } | undefined;
    await holder.transaction(async (execute) => {
      await execute('lock table ops.api_events in access exclusive mode');
      const append = settled(outbox.append(signal));
      const pid = await lockWaiter(execute, 50);
      await terminate(pid);
      caller = await within(append, 5_000, 'the append');
    });
    await turns();
    const after = await settled(outbox.append(signal));
    await holder.close();
    await outbox.close();
    return { caller, after };
  },

  /** The listener: its session ends between notifications; it listens again. */
  async listener() {
    const listener = connectListener(url);
    let listening = 0;
    const relistened = latch();
    await listener.listen(
      'connection_ended_probe',
      () => {},
      () => {
        listening += 1;
        if (listening === 2) relistened.open();
      },
    );
    const [row] = await operator.execute<{ pid: number }>(
      `select pid from pg_stat_activity
        where datname = $1 and query ilike 'listen%connection_ended_probe%'`,
      [new URL(url).pathname.slice(1)],
    );
    await terminate(Number(row?.pid));
    await within(relistened.wait, 20_000, 'listening again');
    await turns();
    await listener.close();
    return { listening };
  },
};

const run = cases[kind];
if (run === undefined) throw new Error(`no case ${kind}`);
const result = await run();
await operator.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
