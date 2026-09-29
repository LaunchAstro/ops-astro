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
import type { Database } from '../../../core-records/src/index.ts';
import { PURGE_OPERATION, type PurgeRefusalCode } from './conversation-lifecycle.ts';

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

/** One pass over one business: declared; the pass is not built yet. */
// eslint-disable-next-line @typescript-eslint/require-await -- the shape only
export async function sweepConversations(
  _database: Database,
  _request: SweepRequest,
): Promise<SweepReport> {
  return { wrapped: [], purged: [], held: [], failed: [], windowUnreadable: false };
}
