// SPDX-License-Identifier: AGPL-3.0-only
//
// A transaction with a deadline (#2240): what the hosted recovery pass runs
// in, so a request that waits the pass out waits no longer than its bound.
//
// Nothing starts once the deadline has passed: a transaction or a statement
// asked for after it throws unsent. A statement still running at the deadline
// is cancelled by the driver's own cancel request, whatever it waits on (row,
// relation or advisory locks, one row after another in one statement), and
// the transaction rolls back on the same connection, which stays in the pool.
// The session is never ended by the server: a session the server ends
// crashes the process through postgres.js 3.4.9 (Sol's design check on #2243).
//
// **A cancel request is waited for once sent.** The server applies one to
// whatever the session is running when it lands. One still on its way when
// the statement ends would land on the ROLLBACK or COMMIT that follows, or on
// the pool's next transaction: a cancelled ROLLBACK leaves the session in an
// aborted transaction, and postgres.js then never gives the connection back,
// so every later pass waits for ever. So a statement whose cancel was sent
// hands back its outcome only once the server has taken the request, and no
// cancel is in flight when the COMMIT or ROLLBACK goes. A transaction ends as
// the server reports it: committed whole, or rolled back with nothing applied.
//
// **A cancel not taken in time closes its connection (S2243-3).** The wait
// for the server to take it is `CANCEL_TAKEN_MS`. Past that the request may
// still land, so the connection is never used again: the driver's own
// `terminate` closes it from the client side, with nothing more sent on it,
// and the server rolls the transaction back as the session ends. Every later
// statement in the transaction fails unsent, and the pool opens a fresh
// session for the next one. The connection is learnt from the transaction's
// first statement, which refuses to go on without it.
//
// **The COMMIT has no deferred work left.** The driver sends the COMMIT
// itself, so no cancel reaches it, and the server switches a statement's
// limit off before the commit-time checks run. So a transaction with a
// deadline ends with `set constraints all immediate`: the deferred checks,
// the cap ceiling among them (0025), run then, under the locks already held
// and with nothing after them but the COMMIT, as they would at it, and that
// statement is cancelled at the deadline like any other.
//
// **The server's own limits are the backstop (S2243-4).** Before each
// statement, in the same write, the transaction sets `statement_timeout` and
// `lock_timeout` locally to the time left then plus a margin, so the cancel
// acts first, and a cancel that never comes, or an instance frozen mid
// statement, still cannot hold a statement past them. Neither is ever 0,
// which would mean no limit.

import type postgres from 'postgres';

/** How long past the deadline the server's own limits wait for a cancel that never came. */
const BACKSTOP_MARGIN_MS = 250;

/** The longest a statement waits for the server to take its cancel request. */
const CANCEL_TAKEN_MS = 500;

/** The part of a postgres.js 3.4.9 connection that closes it from the client side (src/connection.js). */
interface Closable {
  terminate(): void;
}

/** A transaction's deadline and the connection it runs on. */
export interface Deadline {
  /** When, in `Date.now()` milliseconds, the transaction must be over. */
  readonly at: number;
  readonly connection: Closable;
}

/** Where a statement goes: an open transaction, or a savepoint inside one. */
type Sendable = Pick<postgres.Sql, 'unsafe'>;

/** The milliseconds left before `deadline`; throws once none are, so nothing starts after it. */
export function timeLeft(deadline: number): number {
  const left = Math.ceil(deadline - Date.now());
  if (left <= 0) throw new Error('the deadline has passed, so the statement was not started');
  return left;
}

/**
 * The server's limits for a statement starting with `left` milliseconds to
 * go. Without parameters it is one message, so a statement sent behind it
 * goes in the same write; the values are whole numbers this module computes.
 */
function limits(left: number): string {
  const ms = `'${String(left + BACKSTOP_MARGIN_MS)}ms'`;
  return `select set_config('statement_timeout', ${ms}, true), set_config('lock_timeout', ${ms}, true)`;
}

/**
 * The transaction's first statement under `at`: the server's limits, sent so
 * that the driver names the connection it runs on (postgres.js calls a
 * statement's `onexecute` with it, as its own `begin` does). Without one the
 * transaction goes no further, since a cancel not taken could not be fenced.
 */
export async function deadlineOn(sql: Sendable, at: number): Promise<Deadline> {
  const learnt: { connection?: Closable } = {};
  const learn = (connection: Closable): boolean => {
    learnt.connection = connection;
    return true;
  };
  await sql.unsafe(limits(timeLeft(at)), [], {
    prepare: false,
    onexecute: learn,
  } as postgres.UnsafeQueryOptions);
  const { connection } = learnt;
  if (connection === undefined)
    throw new Error('the connection was not named, so nothing was sent');
  return { at, connection };
}

/** The last statement before the COMMIT: the deferred checks, now and under the deadline. */
export async function checkDeferred(
  send: (text: string, parameters: readonly unknown[]) => Promise<unknown>,
): Promise<void> {
  await send('set constraints all immediate', []);
}

/**
 * `send`'s statement on `sql`, sent only before the deadline with the
 * server's limits ahead of it, and cancelled by the driver if still running
 * at the deadline. Without a deadline it is sent as it is.
 */
export async function untilDeadline<T>(
  sql: Sendable,
  deadline: Deadline | undefined,
  send: () => Promise<T>,
): Promise<T> {
  if (deadline === undefined) return await send();
  const left = timeLeft(deadline.at);
  const limited = sql.unsafe(limits(left));
  const pending = send();
  let taken: Promise<boolean> | undefined;
  const timer = setTimeout(() => {
    taken = cancel(pending, deadline.connection);
  }, left);
  await Promise.allSettled([limited, pending]);
  clearTimeout(timer);
  if (taken !== undefined && !(await taken)) {
    throw new Error(
      'the server did not take the cancel request in time, so the connection was closed',
    );
  }
  await limited;
  return await pending;
}

/** The part of a postgres.js 3.4.9 query `cancel()` calls (src/query.js). */
interface Cancellable {
  canceller: ((query: unknown) => Promise<void>) | null | undefined;
}

/**
 * The driver's cancel request for `pending`: true once the server has taken
 * it within `CANCEL_TAKEN_MS`. Past that, or if it could not be sent, the
 * request may yet land on whatever runs next, so `connection` is closed and
 * the answer is false. `cancel()` itself drops the promise its canceller
 * returns, so a cancel request that could not connect would be an unhandled
 * rejection; this keeps it.
 */
async function cancel(pending: Promise<unknown>, connection: Closable): Promise<boolean> {
  const query = pending as unknown as Cancellable;
  const canceller = query.canceller;
  query.canceller = null;
  if (typeof canceller !== 'function') return true;
  const sent = canceller(query).then(
    () => true,
    () => false,
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, CANCEL_TAKEN_MS);
  });
  const taken = await Promise.race([sent, late]);
  clearTimeout(timer);
  if (!taken) connection.terminate();
  return taken;
}
