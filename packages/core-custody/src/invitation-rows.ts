// SPDX-License-Identifier: AGPL-3.0-only
//
// An invitation's send, as its rows see it (C39-T, `broker-invitation.ts`):
// each attempt's observation, the lifetime judged after each lock wait, and
// the read just before custody is asked.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { lapsed, type Reading } from './email-class.ts';

/**
 * One observation, stamped when it is written (`clock_timestamp()`), not when its transaction
 * began: an `asked` counts toward the ceiling from its reservation, however long the send waited
 * on the invitation's lock before it, as `recordAsked` stamps an inbox ask.
 */
export async function recordAttempt(
  tx: TenantQuery,
  asked: { readonly invitationId: string; readonly tokenId: string },
  seen: { readonly state: string; readonly evidence?: string | null },
): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into invitation_delivery_attempts
       (business_id, id, invitation_id, token_id, state, evidence, observed_at)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, clock_timestamp()) returning id`,
    [tx.businessId, asked.invitationId, asked.tokenId, seen.state, seen.evidence ?? null],
  );
  return row?.id ?? '';
}

/**
 * Whether the invitation's lifetime is still running, judged by a statement of its own after each
 * lock the send waits on (the invitation's row, the email limit, then a hook message's claim): a
 * send that waited is judged when it got the lock, never when its transaction began, and never by
 * a lock statement's own reading taken before the wait.
 */
export async function liveNow(tx: TenantQuery, invitationId: string): Promise<boolean> {
  const [row] = await tx.query<{ live: boolean }>(
    `select expires_at > clock_timestamp() as live from invitations
      where business_id = $1 and id = $2`,
    [tx.businessId, invitationId],
  );
  return row?.live === true;
}

/**
 * Why a reserved email may not go now, or undefined, judged just before custody is asked. The
 * invitation's lock ended with the reservation's transaction, so this read is the point a revoke,
 * an acceptance or the expiry is ordered against: one committed before it sends nothing, one after
 * it meets a link enrolment refuses. The fence on the reservation (`lapsed`) is read last.
 */
export async function undispatchable(
  database: Database,
  businessId: BusinessId,
  invitationId: string,
  reserved: Reading,
): Promise<'not_pending' | 'expired' | undefined> {
  const [row] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ live: boolean }>(
        `select state = 'pending' and expires_at > clock_timestamp() as live from invitations
          where business_id = $1 and id = $2`,
        [tx.businessId, invitationId],
      ),
  );
  if (row?.live !== true) return 'not_pending';
  return lapsed(reserved) ? 'expired' : undefined;
}
