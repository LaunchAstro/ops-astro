// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the door asks C35's open, capture, pin and decisions (#2011, #2012, #2014) and C57's
// change requests (#2016), spread into `prepare.ts`'s
// TARGET_LOOKUPS: at the review's holder, the task's client, or the business for a task with
// none (R6), read in this business only. A task or revision that resolves to nothing is asked
// of the business, so a foreign and a fabricated id answer alike.

import type { Scope, TenantQuery } from '../../../core-records/src/index.ts';

type Lookup = readonly [string, (tx: TenantQuery, id: string) => Promise<Scope | undefined>];

const holderOf =
  (sql: string) =>
  async (tx: TenantQuery, id: string): Promise<Scope | undefined> =>
    (await tx.query<Scope>(sql, [tx.businessId, id]))[0];

const REVISION_HOLDER = holderOf(
  `select case when c.party_id is null then 'business' else 'party' end as kind,
          c.party_id as id
     from public.review_revisions v
     join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
    where v.business_id = $1 and v.id = $2`,
);

const holderCase = `case when c.party_id is null then 'business' else 'party' end as kind,
          c.party_id as id`;

const REVIEW_HOLDER = holderOf(
  `select case when party_id is null then 'business' else 'party' end as kind, party_id as id
     from public.reviews where business_id = $1 and id = $2`,
);

type Looked =
  | 'review.open'
  | 'review.capture'
  | 'review.pin_comment'
  | 'review.propose_change'
  | 'review.decide_change'
  | 'review.decide'
  | 'review.record_astra_review';

export const REVIEW_TARGET_LOOKUPS: Readonly<Record<Looked, Lookup>> = {
  'review.open': [
    'taskId',
    holderOf(
      `select case when uuid_7 is null then 'business' else 'party' end as kind, uuid_7 as id
         from public.records where business_id = $1 and id = $2`,
    ),
  ],
  'review.capture': ['revisionId', REVISION_HOLDER],
  'review.pin_comment': ['revisionId', REVISION_HOLDER],
  // The pin's review, through the revision its anchor names.
  'review.propose_change': [
    'commentId',
    holderOf(
      `select ${holderCase}
         from public.records r
         join public.review_revisions v
           on v.business_id = r.business_id and v.id::text = r.data->'anchor'->>'source'
         join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
        where r.business_id = $1 and r.id = $2`,
    ),
  ],
  'review.decide_change': [
    'changeRequestId',
    holderOf(
      `select ${holderCase}
         from public.review_change_requests c where c.business_id = $1 and c.id = $2`,
    ),
  ],
  'review.decide': ['reviewId', REVIEW_HOLDER],
  'review.record_astra_review': ['reviewId', REVIEW_HOLDER],
};
