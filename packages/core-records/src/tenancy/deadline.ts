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
// The session is never ended: a session the server ends crashes the process
// through postgres.js 3.4.9 (Sol's design check on #2243).
//
// **A cancel request is waited for once sent.** The server applies one to
// whatever the session is running when it lands. One still on its way when
// the statement ends would land on the ROLLBACK or COMMIT that follows, or on
// the pool's next statement: a cancelled ROLLBACK leaves the session in an
// aborted transaction, and postgres.js then never gives the connection back,
// so every later pass waits for ever. So a statement whose cancel was sent
// hands back its outcome only once the server has taken the request, and no
// cancel is in flight when the COMMIT or ROLLBACK goes. A transaction ends as
// the server reports it: committed whole, or rolled back with nothing applied.
//
// **The COMMIT has no deferred work left.** The driver sends the COMMIT
// itself, so no cancel reaches it, and the server switches a statement's
// limit off before the commit-time checks run. So a transaction with a
// deadline ends with `set constraints all immediate`: the deferred checks,
// the cap ceiling among them (0025), run then, under the locks already held
// and with nothing after them but the COMMIT, as they would at it, and that
// statement is cancelled at the deadline like any other.
//
// **The server's own limit is the backstop.** Each transaction sets
// `statement_timeout` locally to the time left plus a margin, so the cancel
// acts first and a cancel request that is lost still cannot hold a statement
// past it. It is never 0, which would mean no limit.

/** How long past the deadline the server's own limit waits for a cancel that never came. */
const BACKSTOP_MARGIN_MS = 250;

/** The longest a statement waits for the server to take its cancel request. */
const CANCEL_TAKEN_MS = 500;

/** The milliseconds left before `deadline`; throws once none are, so nothing starts after it. */
export function timeLeft(deadline: number): number {
  const left = Math.ceil(deadline - Date.now());
  if (left <= 0) throw new Error('the deadline has passed, so the statement was not started');
  return left;
}

/** The backstop, as the transaction's first statement: the server's limit on each statement in it. */
export async function limitStatements(
  send: (text: string, parameters: readonly unknown[]) => Promise<unknown>,
  deadline: number,
): Promise<void> {
  const limit = timeLeft(deadline) + BACKSTOP_MARGIN_MS;
  await send(`select set_config('statement_timeout', $1, true)`, [`${String(limit)}ms`]);
}

/** The last statement before the COMMIT: the deferred checks, now and under the deadline. */
export async function checkDeferred(
  send: (text: string, parameters: readonly unknown[]) => Promise<unknown>,
): Promise<void> {
  await send('set constraints all immediate', []);
}

/**
 * `send`'s statement, sent only before `deadline` and cancelled by the driver
 * if still running at it. Without a deadline it is sent as it is.
 */
export async function untilDeadline<T>(
  deadline: number | undefined,
  send: () => Promise<T>,
): Promise<T> {
  if (deadline === undefined) return await send();
  const left = timeLeft(deadline);
  const pending = send();
  let taken: Promise<unknown> | undefined;
  const timer = setTimeout(() => {
    taken = cancel(pending);
  }, left);
  try {
    return await pending;
  } finally {
    clearTimeout(timer);
    if (taken !== undefined) await taken;
  }
}

/** The part of a postgres.js 3.4.9 query `cancel()` calls (src/query.js). */
interface Cancellable {
  canceller: ((query: unknown) => Promise<void>) | null | undefined;
}

/**
 * The driver's cancel request for `pending`, settled once the server has
 * taken it or `CANCEL_TAKEN_MS` has passed. `cancel()` itself drops the
 * promise its canceller returns, so a cancel request that could not connect
 * would be an unhandled rejection; this keeps it and ignores its failure,
 * which leaves the backstop to end the statement.
 */
async function cancel(pending: Promise<unknown>): Promise<void> {
  const query = pending as unknown as Cancellable;
  const canceller = query.canceller;
  query.canceller = null;
  if (typeof canceller !== 'function') return;
  const sent = canceller(query).catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCEL_TAKEN_MS);
  });
  await Promise.race([sent, late]);
  clearTimeout(timer);
}
