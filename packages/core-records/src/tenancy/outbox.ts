// SPDX-License-Identifier: AGPL-3.0-only
//
// The API's outbox connection (S0-2 error outbox; migration 0047).

import { open, type Connection, type DatabaseOptions } from './database.ts';

/** One row of `ops.api_events` (0047): a security signal, or an error's bounded event. */
export interface ApiEvent {
  readonly kind: string;
  /** A keyed digest of the signal's scope, or empty. */
  readonly scope: string;
  readonly weight: number;
  readonly event?: unknown;
}

/**
 * A connection that can only append to the API's outbox (S0-2 error outbox):
 * one fixed insert outside `withBusiness`, because a signal or an error often
 * comes before any business is known. The application group may insert that
 * table's four columns and nothing else (0047), so this handle reads nothing.
 */
export interface Outbox extends Connection {
  append(event: ApiEvent): Promise<void>;
}

export function connectOutbox(url: string, options: DatabaseOptions = {}): Outbox {
  const { sql, log } = open(url, options);

  return {
    log,
    async append({ kind, scope, weight, event }): Promise<void> {
      const data = event === undefined ? null : JSON.stringify(event);
      await sql.unsafe(
        'insert into ops.api_events (kind, scope, weight, event) values ($1, $2, $3, $4::text::jsonb)',
        [kind, scope, weight, data] as never[],
      );
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
