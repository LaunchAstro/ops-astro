// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-10a's commit races' pieces (`mp-14-10a-mandates-commit.test.ts`): a
// look at a command parked on an advisory key, a stop between a transaction's
// real statements, and a sign-in on a provider session of its own.

import { randomUUID } from 'node:crypto';
import type { TransactionQuery } from '../../packages/core-records/src/index.ts';
import { ISSUER } from '../api/fixture.ts';
import type { Member } from '../commands/fixture.ts';
import { signBearer } from '../support/sign-in.ts';

/** A backend parked on an advisory key, and whether it has written a mandate row. */
export const PARKED = `select a.query, exists (
    select 1 from pg_locks l where l.pid = a.pid and l.granted and l.mode = 'RowExclusiveLock'
       and l.relation = 'public.standing_mandates'::regclass) as wrote
  from pg_stat_activity a
 where a.datname = current_database() and a.pid <> pg_backend_pid()
   and a.wait_event_type = 'Lock' and a.wait_event = 'advisory'`;

/** Where a stop waits: the first live session read after the audit event, or the chain's lock. */
export interface Stop {
  armed?: () => Promise<void>;
  at?: 'session' | 'chain';
}

/** One transaction's statements, stopped once where `stop.at` says. */
export function stoppedAfterAudit(tx: TransactionQuery, stop: Stop): TransactionQuery {
  let audited = false;
  const wrapped: TransactionQuery = {
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]) {
      const rows = await tx.query<Row>(text, parameters);
      if (text.includes('insert into audit_events')) audited = true;
      const live = (rows[0] as { readonly ended?: unknown } | undefined)?.ended === false;
      const chained =
        text.includes('pg_advisory_xact_lock(') && parameters?.[0] === tx.businessId.toLowerCase();
      const reached =
        stop.at === 'chain' ? chained : audited && live && text.includes('ended_provider_sessions');
      if (reached && stop.armed) {
        const wait = stop.armed;
        delete stop.armed;
        await wait();
      }
      return rows;
    },
    async savepoint(work) {
      return await tx.savepoint(async (inner) => {
        await work(stoppedAfterAudit(inner, stop));
      });
    },
  };
  return wrapped;
}

/** A fresh second factor on a provider session of its own. */
export async function signedIn(
  who: Member,
): Promise<{ readonly presented: Member['presented']; readonly bearer: string }> {
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const bearer = await signBearer({
    sub: who.presented.subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: now + 600,
    aal: 'aal2',
    amr: [
      { method: 'password', timestamp: now },
      { method: 'totp', timestamp: now },
    ],
    session_id: sessionId,
  });
  return { presented: { ...who.presented, sessionId }, bearer };
}
