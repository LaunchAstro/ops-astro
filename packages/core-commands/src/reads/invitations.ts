// SPDX-License-Identifier: AGPL-3.0-only
//
// `invitation.list` (C39-T): the business's team invitations for Settings ▸
// Access, under `access:share` on the business (its `COMMAND_SURFACE` row),
// never an agent's. The statement is bound to the tenant query's business, so
// another business's invitation is never listed or counted.
//
// A pending invitation whose lifetime has passed is answered `expired` before
// the worker ends it (`invitation-expiry.ts`). `sentAt` is the last delivery
// the provider took. The enrolment tokens are never read: nothing here can
// carry a token or its hash.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { InvitationListResult } from '../../../core-wire/src/index.ts';

/** A time as the driver hands it back: a `Date`, or its text. */
type Time = Date | string;

type Row = Omit<
  InvitationListResult['invitations'][number],
  'createdAt' | 'expiresAt' | 'sentAt'
> & {
  readonly createdAt: Time;
  readonly expiresAt: Time;
  readonly sentAt: Time | null;
};

const iso = (time: Time): string => new Date(time).toISOString();

export async function listInvitations(tx: TenantQuery): Promise<InvitationListResult> {
  const rows = await tx.query<Row>(
    `select i.id as "invitationId", p.display_name as name, i.address, i.role_key as role,
            case when i.state = 'pending' and i.expires_at <= now() then 'expired'
                 else i.state end as state,
            i.created_at as "createdAt", i.expires_at as "expiresAt",
            (select max(a.observed_at) from public.invitation_delivery_attempts a
              where a.business_id = i.business_id and a.invitation_id = i.id
                and a.state in ('accepted', 'delivered')) as "sentAt"
       from public.invitations i
       join public.people p on p.business_id = i.business_id and p.id = i.person_id
      where i.business_id = $1
      order by i.created_at desc, i.id`,
    [tx.businessId],
  );
  return {
    ok: true,
    invitations: rows.map((row) => ({
      invitationId: row.invitationId,
      name: row.name,
      address: row.address,
      role: row.role,
      state: row.state,
      createdAt: iso(row.createdAt),
      sentAt: row.sentAt === null ? null : iso(row.sentAt),
      expiresAt: iso(row.expiresAt),
    })),
  };
}
