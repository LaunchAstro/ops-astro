// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 live-sync 6: the live channel asks an open stream's standing again,
// through `standingOf`, the same steps sign-in takes, and records nothing.
// A served request that resolves its caller only here (the presence routes)
// is charged to its quotas as `withSession` charges one (API-3, `quota.ts`).

import type { CommandRefusal } from '../register.ts';
import type { BusinessId, Database, TenantQuery } from '../tenancy/database.ts';
import type { IdentityRefusalCode } from './refusals.ts';
import type { VerifiedSubject } from './verified-subject.ts';
import { standingOf, type Session } from './login-resolution.ts';
import { admitQuota, type QuotaRefusal } from './quota.ts';

/**
 * `withSession` for a session already admitted at the door and asked again:
 * the live channel's recheck of an open stream (C4 live-sync 6). The standing
 * is resolved the same way, so a lost membership, an inactive actor, a session
 * the person has ended or a missing second factor still refuses, and nothing
 * is recorded: the attempt was recorded when the stream was opened, and a row
 * for every recheck would record who kept which task open rather than who came
 * through the door. A request that comes to no door of its own is charged
 * here; one charged already (a stream's recheck) is not charged again. Its
 * refusal is recorded, as every quota refusal is.
 */
export async function withStanding<T>(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  run: (tx: TenantQuery, session: Session) => Promise<T>,
): Promise<T | CommandRefusal<IdentityRefusalCode> | QuotaRefusal> {
  return await database.withBusiness(businessId, async (tx) => {
    const standing = await standingOf(tx, presented, 'required');
    if ('refused' in standing) return standing;
    const overQuota = await admitQuota(tx, 'person_login', presented, {
      credential: standing.loginId,
      person: standing.personId,
    });
    if (overQuota !== undefined) return overQuota;
    return await run(tx, standing);
  });
}
