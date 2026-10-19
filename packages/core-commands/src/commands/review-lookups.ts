// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the door asks C35's open and capture (#2011), spread into `prepare.ts`'s
// TARGET_LOOKUPS: at the review's holder, the task's client, or the business for a task with
// none (R6), read in this business only. A task or revision that resolves to nothing is asked
// of the business, so a foreign and a fabricated id answer alike.

import type { Scope, TenantQuery } from '../../../core-records/src/index.ts';

type Lookup = readonly [string, (tx: TenantQuery, id: string) => Promise<Scope | undefined>];

const holderOf =
  (sql: string) =>
  async (tx: TenantQuery, id: string): Promise<Scope | undefined> =>
    (await tx.query<Scope>(sql, [tx.businessId, id]))[0];

export const REVIEW_TARGET_LOOKUPS: Readonly<Record<'review.open' | 'review.capture', Lookup>> = {
  'review.open': [
    'taskId',
    holderOf(
      `select case when uuid_7 is null then 'business' else 'party' end as kind, uuid_7 as id
         from public.records where business_id = $1 and id = $2`,
    ),
  ],
  'review.capture': [
    'revisionId',
    holderOf(
      `select case when c.party_id is null then 'business' else 'party' end as kind,
              c.party_id as id
         from public.review_revisions v
         join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
        where v.business_id = $1 and v.id = $2`,
    ),
  ],
};
