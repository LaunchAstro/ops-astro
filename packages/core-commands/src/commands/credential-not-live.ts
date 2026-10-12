// SPDX-License-Identifier: AGPL-3.0-only
//
// The one answer for an API-2 credential not served, at the door or after a lock wait (`onboarding-authority.ts`),
// and the expiry asked again after a command's last wait (`credential-envelope.ts`).

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

const NOT_LIVE_FIXES: readonly string[] = [
  'This agent credential is not live: it was revoked, it has expired, or it was never issued here.',
  'Ask the person it acts for to issue a new one on Settings ▸ Access.',
];

/** The one answer for a credential not served: unknown, revoked, expired, or a key nobody holds. */
export const credentialNotLive = (): CommandRefusal =>
  refuseCommand('DELEGATION_NOT_LIVE', [], NOT_LIVE_FIXES);

/**
 * The credential judged again once a command has done its work (#1011): its
 * row is still held `for share` and the access lock with it, so no revocation,
 * deactivation or ended membership has committed since it was resolved, and
 * only its expiry can have passed, read on the database's clock now.
 */
export const lapsedSince =
  (credentialId: string) =>
  async (tx: TenantQuery): Promise<CommandRefusal | undefined> => {
    const [row] = await tx.query<{ readonly lapsed: boolean }>(
      `select expires_at <= clock_timestamp() as lapsed from public.agent_credentials
        where business_id = $1 and id = $2`,
      [tx.businessId, credentialId],
    );
    return row?.lapsed === false ? undefined : credentialNotLive();
  };
