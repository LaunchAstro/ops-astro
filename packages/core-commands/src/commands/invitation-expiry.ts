// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: `invitation expired`, the system's write. A pending invitation whose
// lifetime has passed is ended by the business's worker, never by a person's
// grant, with one audit event per invitation in the same transaction. A pass
// is idempotent: an expired invitation is not pending, so a second pass finds
// nothing. `invitation.create` runs the same expiry over its own address first,
// so a lapsed invitation never blocks a new one.

import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { Database, TenantQuery } from '../../../core-records/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { workerActor } from './conversation-lifecycle.ts';

export const EXPIRE_OPERATION = 'invitation.expire';

/**
 * End the business's lapsed pending invitations, or those of one address.
 * Judged on the clock now, not the transaction's start: a create that waited
 * at its limiter sees an expiry that passed meanwhile.
 */
export async function expireDue(tx: TenantQuery, address?: string): Promise<readonly string[]> {
  const ended = await tx.query<{ id: string }>(
    `update invitations set state = 'expired', ended_at = clock_timestamp(), revision = revision + 1
      where business_id = $1 and state = 'pending' and expires_at <= clock_timestamp()
        and ($2::text is null or address = $2)
      returning id`,
    [tx.businessId, address ?? null],
  );
  if (ended.length === 0) return [];
  const actorId = await workerActor(tx);
  for (const { id } of ended) {
    // One event per invitation, in turn: the chain's trigger orders them.
    // eslint-disable-next-line no-await-in-loop
    await writeAuditEvent(tx, {
      actorId,
      command: EXPIRE_OPERATION,
      operationId: `${EXPIRE_OPERATION}:${id}`,
      outcome: 'applied',
      subjectRecordId: id,
      payloadDigest: payloadDigest({ invitationId: id }),
    });
  }
  return ended.map((row) => row.id);
}

/** One pass over one business, as its worker. */
export async function expireInvitations(
  database: Database,
  businessId: string,
): Promise<readonly string[]> {
  return await database.withBusiness(businessId, async (tx) => await expireDue(tx));
}
