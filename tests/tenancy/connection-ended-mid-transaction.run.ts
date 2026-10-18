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
// case ends a backend with, as an operator's `pg_terminate_backend` would.

import {
  connect,
  connectAsAdmin,
  connectListener,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';

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

/** Some turns of the event loop, so a write postgres.js put off with setImmediate has run. */
const turns = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const cases: Record<string, () => Promise<Record<string, unknown>>> = {
  /**
   * The runtime pool. The transaction's backend ends; the caller's own next
   * statement on it, and the rollback postgres.js sends when that one fails,
   * go to a connection that has no socket.
   */
  async runtime() {
    const db = connect(url, { max: 1 });
    let ended!: () => void;
    const closedSeen = new Promise<void>((resolve) => (ended = resolve));
    let statement: { ok: boolean; code?: string } | undefined;
    const call = db.withBusiness(ALPHA, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      await terminate(Number(row?.pid));
      await closedSeen;
      const next = tx.query('select 1');
      statement = await settled(next);
      await next;
    });
    const outcome = settled(call).finally(ended);
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
    let ended!: () => void;
    const closedSeen = new Promise<void>((resolve) => (ended = resolve));
    let betaHolding!: () => void;
    const betaInside = new Promise<void>((resolve) => (betaHolding = resolve));
    let alphaDone!: () => void;
    const alphaFinished = new Promise<void>((resolve) => (alphaDone = resolve));
    let statement: { ok: boolean; code?: string } | undefined;

    const alpha = db.withBusiness(ALPHA, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      await terminate(Number(row?.pid));
      await closedSeen;
      await betaInside;
      statement = await settled(tx.query(`select set_config('app.stale', 'alpha', true)`));
      // postgres.js commits once this returns; give that its turns too.
      setTimeout(alphaDone, 200);
      return 'alpha finished';
    });
    const alphaOutcome = settled(alpha).finally(ended);

    await closedSeen;
    const beta = db.withBusiness(BETA, async (tx) => {
      await tx.query(`select set_config('app.stale', 'beta', true)`);
      betaHolding();
      await alphaFinished;
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
    let ended!: () => void;
    const closedSeen = new Promise<void>((resolve) => (ended = resolve));
    let statement: { ok: boolean; code?: string } | undefined;
    const call = admin.transaction(async (execute) => {
      const [row] = await execute<{ pid: number }>('select pg_backend_pid() as pid');
      await terminate(Number(row?.pid));
      await closedSeen;
      const next = execute('select 1');
      statement = await settled(next);
      await next;
    });
    const outcome = settled(call).finally(ended);
    const caller = await within(outcome, 5_000, 'the transaction');
    await turns();
    const after = await settled(admin.execute('select 1'));
    await admin.close();
    return { caller, statement, after };
  },

  /** The listener: its session ends between notifications; it listens again. */
  async listener() {
    const listener = connectListener(url);
    let listening = 0;
    let again!: () => void;
    const relistened = new Promise<void>((resolve) => (again = resolve));
    await listener.listen(
      'connection_ended_probe',
      () => {},
      () => {
        listening += 1;
        if (listening === 2) again();
      },
    );
    const [row] = await operator.execute<{ pid: number }>(
      `select pid from pg_stat_activity
        where datname = $1 and query ilike 'listen%connection_ended_probe%'`,
      [new URL(url).pathname.slice(1)],
    );
    await terminate(Number(row?.pid));
    await within(relistened, 20_000, 'listening again');
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
