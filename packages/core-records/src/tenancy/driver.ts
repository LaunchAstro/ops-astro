// SPDX-License-Identifier: AGPL-3.0-only
//
// The driver under every connection the tenancy wrapper hands out: one
// postgres.js handle over a URL, with the statement log its traffic feeds and
// the startup settings that log relies on. `database.ts` builds the wrapper's
// connections on it; nothing else opens one.
//
// postgres.js 3.4.9 runs patched (patches/postgres.patch, #1774). When the
// server ends a connection mid-transaction, 3.4.9 wrote the transaction's next
// statement, or the rollback or commit `begin` adds, to the closed socket from
// a timer, an uncaught TypeError that ended the process; after a reconnect it
// wrote them into the new session, which could be another business's
// transaction. Patched, a transaction whose connection closed sends nothing
// more and each of its statements is refused with CONNECTION_CLOSED.
// tests/tenancy/connection-ended-mid-transaction.test.ts holds it, and an
// upgrade must keep that test green or carry the patch forward.

import postgres from 'postgres';
import { createStatementLog, type StatementLog } from './statements.ts';

export interface DatabaseOptions {
  /** What to label this connection's statements: `runtime`, `migration`, `harness`. */
  readonly source?: string;
  /**
   * Share one log across connections when the run wants a single trail. A
   * proof that reads the whole history passes one; without it the connection
   * keeps only its newest statements, so a server's heap does not grow with
   * its traffic.
   */
  readonly log?: StatementLog;
  readonly max?: number;
  /**
   * Close a connection once it has sat idle this many seconds; unset, it stays
   * open until the handle ends. Only a handle that keeps no session state
   * between statements may set it: a closed connection reopens on the next
   * statement, and a session advisory lock or `set role` would be gone.
   */
  readonly idleSeconds?: number;
}

/**
 * How long the runtime pools keep an idle connection (#1530). A migration and
 * the staging reset refuse while any other session is connected, and a warm
 * hosted function with no traffic otherwise held its sessions for as long as
 * the instance lived, so a migrate window could not drain.
 */
export const RUNTIME_IDLE_SECONDS = 20;

/**
 * The driver over `url`. postgres.js parses the address at once, and its
 * parse error carries the whole address, password and all, as its input; the
 * server and the hosted function log what they catch. So the refusal names
 * the problem and carries nothing of the address, not even as its cause.
 */
function parsed(url: string, options: postgres.Options<Record<string, never>>): postgres.Sql {
  try {
    return postgres(url, options);
  } catch {
    throw new Error(
      'The database address could not be read. Check its form; it is not repeated here because it holds a password.',
    );
  }
}

export function open(
  url: string,
  options: DatabaseOptions,
): { sql: postgres.Sql; log: StatementLog } {
  const log = options.log ?? createStatementLog({ keep: 1_000 });
  const source = options.source ?? 'runtime';
  const sql = parsed(url, {
    max: options.max ?? 1,
    ...(options.idleSeconds === undefined ? {} : { idle_timeout: options.idleSeconds }),
    prepare: false,
    onnotice: () => {},
    debug: (_connection: number, query: string) => {
      log.record(source, query);
    },
    // The log reads a plain string as standard_conforming_strings = on does.
    // Every connection starts with it on, so a database or role default of
    // off does not apply, and RESET comes back to on. The server reports each
    // change of it however it was made (SET, SET LOCAL, set_config, a function
    // body), and a change away from on is recorded as a point the log cannot
    // read past.
    connection: { standard_conforming_strings: 'on' },
    onparameter: (key: string, value: unknown) => {
      if (key === 'standard_conforming_strings' && value !== 'on') {
        log.unreadable(source, `standard_conforming_strings = ${String(value)}`);
      }
    },
  });
  // postgres.js puts a URL's query parameters into the startup packet after
  // `connection` above, so one naming the setting, in any case and with any
  // value or none, would have its way. The wrapper
  // owns the setting instead of refusing the URL: it rewrites the parameters
  // postgres.js resolved, which every connection of this handle shares and
  // reads when it builds its startup packet (connection.js, StartupMessage),
  // to hold exactly one `on`. Nothing has connected yet; postgres.js connects
  // on the first query. An `options=-c ...` switch is no conflict: the server
  // applies the named parameter after it.
  const startup = sql.options.connection as Record<string, unknown>;
  for (const key of Object.keys(startup)) {
    if (key.toLowerCase() === 'standard_conforming_strings') delete startup[key];
  }
  startup['standard_conforming_strings'] = 'on';
  return { sql, log };
}
