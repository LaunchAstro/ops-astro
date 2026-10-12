// SPDX-License-Identifier: AGPL-3.0-only
//
// The driver under every connection the tenancy wrapper hands out: one
// postgres.js handle over a URL, with the statement log its traffic feeds and
// the startup settings that log relies on. `database.ts` builds the wrapper's
// connections on it; nothing else opens one.

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
}

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
