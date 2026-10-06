// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may be in a team conversation (C71-D), beside `conversations.ts` (moved whole for the line cap).

import type { TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';

/**
 * Whether a person is staff here: an active membership as owner, administrator
 * or member. A client's person and an agent are never one, so never a member.
 */
export async function isStaff(tx: TenantQuery, personId: string): Promise<boolean> {
  if (!isUuid(personId)) return false;
  const rows = await tx.query(
    `select 1 from public.memberships
      where business_id = $1 and person_id = $2 and active
        and role_key in ('owner', 'admin', 'member')`,
    [tx.businessId, personId],
  );
  return rows.length > 0;
}
