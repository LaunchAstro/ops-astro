// SPDX-License-Identifier: AGPL-3.0-only
//
// The people a task may be assigned to.
//
// "Active membership" is the whole of it, and it is the same condition
// `resolveLogin` uses to decide whether a caller may act at all. That is
// deliberate: the assignee choices a screen offers and the people the server
// will accept an assignment to have to be one list, or the screen offers a
// choice the server then refuses.
//
// Nothing here crosses a business. The query is scoped by the business the
// session set and row security holds the same line underneath it, so a person
// of another business is not filtered out -- they are not visible to filter.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { TeamMemberView } from '../../../core-wire/src/index.ts';
import type { PersonView } from './requests.ts';
import { isInternalReader } from './tasks.ts';

export async function listPeople(tx: TenantQuery): Promise<readonly PersonView[]> {
  const rows = await tx.query<{ readonly id: string; readonly display_name: string }>(
    `select p.id, p.display_name
       from public.people p
       join public.memberships m
         on m.business_id = p.business_id and m.person_id = p.id and m.active
      where p.business_id = $1
      order by p.display_name`,
    [tx.businessId],
  );
  return rows.map((row) => ({ personId: row.id, name: row.display_name }));
}

/**
 * The Team panel's people strip (MP-7-10): the business's staff, each with
 * their availability, or none when they never set it (available). A client of
 * the business is not on it: the list is staff only, as the panel is.
 */
export async function listTeam(tx: TenantQuery): Promise<readonly TeamMemberView[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly display_name: string;
    readonly role_key: string;
    readonly state: 'available' | 'away' | null;
    readonly reason: string | null;
  }>(
    `select p.id, p.display_name, m.role_key, a.state, a.reason
       from public.people p
       join public.memberships m
         on m.business_id = p.business_id and m.person_id = p.id and m.active
       left join public.person_availability a
         on a.business_id = p.business_id and a.person_id = p.id
      where p.business_id = $1
      order by p.display_name, p.id`,
    [tx.businessId],
  );
  return rows
    .filter((row) => isInternalReader(row.role_key))
    .map((row) => ({
      personId: row.id,
      name: row.display_name,
      availability: row.state === null ? null : { state: row.state, reason: row.reason },
    }));
}
