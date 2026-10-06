// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's grant filter, shared by every covered read and write over
// `live_corrections` (0311): the caller's grant at the correction's own party,
// judged in the query at the instant the statement reads the clock, and the
// share lock that keeps the grants a covered write rests on in place until it
// commits.

import { EFFECTIVE, askedFor, type Subject } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/**
 * The effective grants, and the instant the statement reads the clock:
 * `now()` is the transaction's start, so a grant that expired since then
 * would still cover a later read in the same transaction.
 */
export const EFFECTIVE_AT: string = `${EFFECTIVE}, instant as materialized (select clock_timestamp() as at)`;

/** Covered by a grant still live at the statement's instant: one that ended by then covers nothing. */
export const COVERED: string = `exists (
    select 1 from effective e
     where e.collection = $2 and e.action = $3
       and (e.expires_at is null or e.expires_at > (select i.at from instant i))
       and exists (select 1 from unnest($4::text[], $5::uuid[]) as s (kind, id)
                    where s.kind = e.subject_kind and s.id = e.subject_id)
       and (e.scope_kind = 'business' or (e.scope_kind = 'party' and e.scope_id = c.party_id)))`;

export interface Covering {
  readonly subjects: readonly Subject[];
  readonly collection: string;
  readonly action: string;
}

/**
 * The query's parameters, with only the subjects asked about this key: an
 * agent credential's person counts within the keys it ticked (API-2), so the
 * guarantee lives here and not in each caller.
 */
export const coveringParameters = (covering: Covering): readonly unknown[] => {
  const asked = askedFor(covering.subjects, covering);
  return [
    covering.collection,
    covering.action,
    asked.map((subject) => subject.kind),
    asked.map((subject) => subject.id),
  ];
};

/**
 * Share-lock, in id order, every grant the covering subjects hold on this key
 * and each grant it descends from, for the rest of the transaction. A
 * revocation that committed first is seen by the caller's next statement; one
 * that comes later waits for the caller's write to commit.
 */
export async function holdCoveringGrants(tx: TenantQuery, covering: Covering): Promise<void> {
  await tx.query(
    `with recursive chain as (
       select g.id, g.parent_grant_id from public.grants g
        where g.business_id = $1 and g.collection = $2 and g.action = $3
          and exists (select 1 from unnest($4::text[], $5::uuid[]) as s (kind, id)
                       where s.kind = g.subject_kind and s.id = g.subject_id)
       union
       select p.id, p.parent_grant_id from public.grants p
         join chain c on p.id = c.parent_grant_id
        where p.business_id = $1
     )
     select g.id from public.grants g
      where g.business_id = $1 and g.id in (select id from chain)
      order by g.id
      for share`,
    [tx.businessId, ...coveringParameters(covering)],
  );
}

/**
 * Whether a grant live at this statement's own instant covers `partyId` (null:
 * only a business-wide grant counts). A write asks it after its last lock wait,
 * with its grants held, so one revoked or expired during a wait covers nothing.
 */
export async function coveredAt(
  tx: TenantQuery,
  covering: Covering,
  partyId: string | null,
): Promise<boolean> {
  const rows = await tx.query<{ readonly covered: boolean }>(
    `${EFFECTIVE_AT}
     select true as covered from (select $1::uuid as business_id, $6::uuid as party_id) c
      where ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), partyId],
  );
  return rows.length > 0;
}
