// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's sign-out, recorded (C58 refresh revoked; migration 0065).

import { open, type Connection, type DatabaseOptions } from './database.ts';

/**
 * The one statement that ends a provider session installation-wide. Login
 * resolution refuses a token whose session is named here, in every business.
 * Written again for a session already ended, it changes nothing.
 */
export const END_PROVIDER_SESSIONS = `insert into ops.ended_provider_sessions (session_id)
  select ids.id from unnest($1::uuid[]) as ids (id)
  on conflict (session_id) do nothing`;

/**
 * A connection that can only end a provider session: one fixed insert outside
 * `withBusiness`, because the browser's sign-out names no business (its login
 * may reach several). The application group may insert and read the table's
 * one id column and nothing else (0065), and this handle reads nothing.
 */
export interface SessionEnds extends Connection {
  end(sessionId: string): Promise<void>;
}

export function connectSessionEnds(url: string, options: DatabaseOptions = {}): SessionEnds {
  const { sql, log } = open(url, options);

  return {
    log,
    async end(sessionId): Promise<void> {
      await sql.unsafe(END_PROVIDER_SESSIONS, [[sessionId]] as never[]);
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
