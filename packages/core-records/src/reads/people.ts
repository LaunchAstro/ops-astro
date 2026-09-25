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

import type { TenantQuery } from '../tenancy/database.ts';
import type { PersonView } from './requests.ts';

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
