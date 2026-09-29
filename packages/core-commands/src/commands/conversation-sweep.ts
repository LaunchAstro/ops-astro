// SPDX-License-Identifier: AGPL-3.0-only
//
// The idle sweep over one business's conversations (AW-03): the deterministic
// pass that writes each quiet conversation's wrap-up and purges each body
// whose window has passed.
//
// Each conversation is its own transaction, so a failure is that
// conversation's alone: its write rolls back whole, its body stays, and the
// pass reports it and carries on. A conversation another transaction holds is
// waited on for `lockTimeoutMs` and then reported, never waited on for ever.
// Purge candidates are chosen before this pass writes any wrap-up, so a
// wrap-up is always written at quiet by one pass and a body purged by a later
// one, never both at once. An unreadable window stops the purge for the whole
// business and the report says so.
//
// Nothing here schedules the pass or owns its retries: a failure is reported
// to the caller, and raising it as an inbox item is INB-1's.

import { createHash } from 'node:crypto';
import type { Database, TenantQuery } from '../../../core-records/src/index.ts';
import {
  PURGE_OPERATION,
  QUIET_HOURS,
  WINDOW_FLOOR_DAYS,
  purgeConversation,
  writeWrapUp,
  type PurgeRefusalCode,
} from './conversation-lifecycle.ts';

/** At most this many conversations of each kind in one pass. */
const PASS_LIMIT = 100;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export interface SweepRequest {
  readonly businessId: string;
  /** The code revision the pass runs, recorded on each wrap-up. */
  readonly codeRevision: string;
  readonly lockTimeoutMs?: number;
}

export interface SweepReport {
  readonly wrapped: readonly string[];
  readonly purged: readonly string[];
  readonly held: readonly { readonly conversationId: string; readonly code: PurgeRefusalCode }[];
  readonly failed: readonly {
    readonly conversationId: string;
    readonly stage: 'wrap_up' | 'purge';
  }[];
  /** The business's window could not be read, so nothing of it was purged. */
  readonly windowUnreadable: boolean;
}

interface Candidate {
  readonly id: string;
  readonly last_activity_at: Date;
}

/**
 * The purge's operation identity for one conversation at one last activity,
 * so a pass retried after a lost answer asks for the same purge.
 */
export function sweepPurgeOperationId(conversationId: string, lastActivityAt: Date): string {
  const hex = createHash('sha256')
    .update(`${PURGE_OPERATION}|${conversationId}|${lastActivityAt.toISOString()}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function candidates(tx: TenantQuery): Promise<{
  readonly quiet: readonly Candidate[];
  readonly purgeable: readonly Candidate[];
}> {
  const quiet = await tx.query<Candidate>(
    `select c.id, c.last_activity_at from conversations c
      where c.business_id = $1 and c.body_purged_at is null
        and c.last_activity_at <= now() - make_interval(hours => $2::int)
        and not exists (
          select 1 from conversation_wrap_ups w
           where w.business_id = c.business_id and w.conversation_id = c.id
             and w.activity_through = c.last_activity_at)
      order by c.last_activity_at, c.id limit $3`,
    [tx.businessId, QUIET_HOURS, PASS_LIMIT],
  );
  const purgeable = await tx.query<Candidate>(
    `select c.id, c.last_activity_at from conversations c
      where c.business_id = $1 and c.body_purged_at is null
        and c.last_activity_at <= now() - make_interval(days => $2::int)
        and exists (
          select 1 from conversation_wrap_ups w
           where w.business_id = c.business_id and w.conversation_id = c.id
             and w.activity_through = c.last_activity_at)
      order by c.last_activity_at, c.id limit $3`,
    [tx.businessId, WINDOW_FLOOR_DAYS, PASS_LIMIT],
  );
  return { quiet, purgeable };
}

async function boundedWait(tx: TenantQuery, lockTimeoutMs: number): Promise<void> {
  await tx.query(`select set_config('lock_timeout', $1, true)`, [
    `${String(Math.max(1, Math.trunc(lockTimeoutMs)))}ms`,
  ]);
}

/** One pass over one business. */
export async function sweepConversations(
  database: Database,
  request: SweepRequest,
): Promise<SweepReport> {
  const { businessId, codeRevision } = request;
  const lockTimeoutMs = request.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const found = await database.withBusiness(businessId, candidates);
  const wrapped: string[] = [];
  const purged: string[] = [];
  const held: { conversationId: string; code: PurgeRefusalCode }[] = [];
  const failed: { conversationId: string; stage: 'wrap_up' | 'purge' }[] = [];
  for (const { id } of found.quiet) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one conversation, one transaction, in turn
      const outcome = await database.withBusiness(businessId, async (tx) => {
        await boundedWait(tx, lockTimeoutMs);
        return await writeWrapUp(tx, { conversationId: id, codeRevision });
      });
      if (outcome.ok && outcome.written) wrapped.push(id);
    } catch {
      failed.push({ conversationId: id, stage: 'wrap_up' });
    }
  }
  for (const { id, last_activity_at: lastActivityAt } of found.purgeable) {
    const operationId = sweepPurgeOperationId(id, lastActivityAt);
    let outcome;
    try {
      // eslint-disable-next-line no-await-in-loop -- one conversation, one transaction, in turn
      outcome = await database.withBusiness(businessId, async (tx) => {
        await boundedWait(tx, lockTimeoutMs);
        return await purgeConversation(tx, { conversationId: id, operationId });
      });
    } catch {
      failed.push({ conversationId: id, stage: 'purge' });
      continue;
    }
    if (outcome.ok) {
      if (!outcome.replayed) purged.push(id);
    } else if (outcome.code === 'WINDOW_UNREADABLE') {
      return { wrapped, purged, held, failed, windowUnreadable: true };
    } else if (outcome.code !== 'NOT_FOUND') {
      held.push({ conversationId: id, code: outcome.code });
    }
  }
  return { wrapped, purged, held, failed, windowUnreadable: false };
}
