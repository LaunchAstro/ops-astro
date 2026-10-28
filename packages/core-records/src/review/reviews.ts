// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's records (#2011, migration 20261019140000): a review on its task, its
// numbered revisions and their captures at two widths.
//
// A review's holder is its task's client, or none for the business's own site
// (R6), and every read and person write here filters by the caller's grant at
// that holder inside the query (`covering.ts`, the live correction's filter),
// so a party grant on one client reaches no other client's review and a caller
// with no grant meets the answer a review that is not there gets. The page is
// one the holder's site binds, read with the site share-locked first and the
// page key-share locked after, the order an unbind takes them. The capture
// claim and land are the worker's, in `captures.ts`.

import { createHash, randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { shareClientSite } from '../site/party-sites.ts';
import {
  COVERED,
  EFFECTIVE_AT,
  coveringParameters,
  holdCoveringGrants,
  type Covering,
} from '../site/covering.ts';

export const REVIEW_COLLECTION = 'review';
/** The two widths a revision is captured at: a laptop and a phone. */
export const CAPTURE_WIDTHS = [1480, 390] as const;
export type CaptureWidth = (typeof CAPTURE_WIDTHS)[number];

export interface Review {
  readonly id: string;
  readonly taskId: string;
  /** The task's client; null for the business's own site. */
  readonly partyId: string | null;
  readonly kind: 'page' | 'media';
  readonly pageUrl: string | null;
  readonly path: string | null;
  readonly revisionCount: number;
}

export interface Revision {
  readonly id: string;
  readonly reviewId: string;
  readonly number: number;
  readonly digest: string;
}

/** Who wrote: a person, or an agent inside a delegation for that person. */
export interface ReviewWriter {
  readonly actorId: string;
  readonly personId: string;
  readonly delegationId: string | null;
}

export type ReviewRefusal = {
  readonly code: 'NOT_FOUND' | 'PAGE_OUTSIDE_HOLDER_SITE' | 'CAPTURE_ALREADY_ASKED';
};

const REVIEW_COLUMNS = `c.id, c.task_id, c.party_id, c.kind, c.page_url, c.path, c.revision_count`;

interface ReviewRow {
  readonly id: string;
  readonly task_id: string;
  readonly party_id: string | null;
  readonly kind: 'page' | 'media';
  readonly page_url: string | null;
  readonly path: string | null;
  readonly revision_count: number;
}

const reviewFrom = (row: ReviewRow): Review => ({
  id: row.id,
  taskId: row.task_id,
  partyId: row.party_id,
  kind: row.kind,
  pageUrl: row.page_url,
  path: row.path,
  revisionCount: row.revision_count,
});

/** The digest a page revision is bound by: its review, number, page and source revision. */
const revisionDigest = (review: Review, number: number, sourceRevision: string): string =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify([review.id, number, review.pageUrl, review.path, sourceRevision]))
    .digest('hex')}`;

/**
 * The holder's site share-locked, then the page key-share locked if that site binds it: true when
 * it does. An unbind takes the site before the page, so this does too.
 */
async function holdBoundPage(
  tx: TenantQuery,
  page: { readonly partyId: string | null; readonly pageUrl: string; readonly path: string },
): Promise<boolean> {
  await shareClientSite(tx, page.partyId);
  const rows = await tx.query<{ readonly bound: boolean }>(
    `select true as bound from public.party_site_pages p
      where p.business_id = $1 and p.holder = coalesce($2::uuid, $1) and p.page_url = $3
        and p.path = $4
        for key share of p`,
    [tx.businessId, page.partyId, page.pageUrl, page.path],
  );
  return rows.length > 0;
}

/** The live task's client (null: none), or undefined for no live task by that id. */
async function holderOfTask(
  tx: TenantQuery,
  taskId: string,
): Promise<{ readonly partyId: string | null } | undefined> {
  const [row] = await tx.query<{ readonly party_id: string | null }>(
    `select r.uuid_7 as party_id from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and r.id = $2 and t.key = 'task' and r.deleted_at is null
        for share of r`,
    [tx.businessId, taskId],
  );
  return row === undefined ? undefined : { partyId: row.party_id };
}

/**
 * Open a page review on a task, or add the next revision to the one already open on that page.
 * The holder is read from the task under a share lock, so a client change waits for the open, and
 * the page must be one that holder's site binds. Revisions are numbered under the review's row
 * lock; two opens at once both land, one after the other.
 */
export async function openPageReview(
  tx: TenantQuery,
  input: {
    readonly taskId: string;
    readonly pageUrl: string;
    readonly path: string;
    readonly sourceRevision: string;
    readonly writer: ReviewWriter;
    /** The live correction whose published page this revision captures; its caller judged it. */
    readonly correctionId?: string | null;
  },
): Promise<{ readonly review: Review; readonly revision: Revision } | ReviewRefusal> {
  const holder = await holderOfTask(tx, input.taskId);
  if (holder === undefined) return { code: 'NOT_FOUND' };
  const page = { partyId: holder.partyId, pageUrl: input.pageUrl, path: input.path };
  if (!(await holdBoundPage(tx, page))) return { code: 'PAGE_OUTSIDE_HOLDER_SITE' };
  const review = await lockPageReview(tx, { ...input, partyId: holder.partyId });
  const revision = await addRevision(tx, review, input);
  return { review: { ...review, revisionCount: revision.number }, revision };
}

/** The task's review of this page, inserted if there is none, then locked for its next number. */
async function lockPageReview(
  tx: TenantQuery,
  input: {
    readonly taskId: string;
    readonly partyId: string | null;
    readonly pageUrl: string;
    readonly path: string;
    readonly writer: ReviewWriter;
  },
): Promise<Review> {
  const { writer } = input;
  await tx.query(
    `insert into public.reviews
       (business_id, id, task_id, party_id, kind, page_url, path, opened_by_actor_id,
        opened_by_person_id, delegation_id)
     values ($1, $2, $3, $4, 'page', $5, $6, $7, $8, $9)
     on conflict (business_id, task_id, page_url, path) where kind = 'page' do nothing`,
    [
      tx.businessId,
      randomUUID(),
      input.taskId,
      input.partyId,
      input.pageUrl,
      input.path,
      writer.actorId,
      writer.personId,
      writer.delegationId,
    ],
  );
  const [row] = await tx.query<ReviewRow>(
    `select ${REVIEW_COLUMNS} from public.reviews c
      where c.business_id = $1 and c.task_id = $2 and c.kind = 'page' and c.page_url = $3
        and c.path = $4
        for update of c`,
    [tx.businessId, input.taskId, input.pageUrl, input.path],
  );
  if (row === undefined) throw new Error('lockPageReview: the review inserted or found above');
  return reviewFrom(row);
}

/** The locked review's next revision, numbered and digested, and the count it moves to. */
async function addRevision(
  tx: TenantQuery,
  review: Review,
  input: {
    readonly sourceRevision: string;
    readonly writer: ReviewWriter;
    readonly correctionId?: string | null;
  },
): Promise<Revision> {
  const { sourceRevision, writer } = input;
  const number = review.revisionCount + 1;
  const revision: Revision = {
    id: randomUUID(),
    reviewId: review.id,
    number,
    digest: revisionDigest(review, number, sourceRevision),
  };
  await tx.query(
    `insert into public.review_revisions
       (business_id, id, review_id, number, digest, source_revision, created_by_actor_id,
        created_by_person_id, delegation_id, correction_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tx.businessId,
      revision.id,
      review.id,
      number,
      revision.digest,
      sourceRevision,
      writer.actorId,
      writer.personId,
      writer.delegationId,
      input.correctionId ?? null,
    ],
  );
  await tx.query(
    `update public.reviews set revision_count = $3, updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, review.id, number],
  );
  return revision;
}

/**
 * Ask both widths' captures of a revision whose review the caller's grant covers at its holder.
 * The page is held bound first (site, then page), then the review is locked and the grant judged
 * in that statement and again once the covering grants are held, so a grant revoked while the
 * ask waited covers nothing. A media review, or a revision asked already, stores nothing.
 */
export async function askCaptures(
  tx: TenantQuery,
  revisionId: string,
  covering: Covering,
  writer: ReviewWriter,
): Promise<{ readonly review: Review; readonly captureIds: readonly string[] } | ReviewRefusal> {
  const [named] = await tx.query<ReviewRow>(
    `select ${REVIEW_COLUMNS} from public.reviews c
       join public.review_revisions v on v.business_id = c.business_id and v.review_id = c.id
      where c.business_id = $1 and v.id = $2`,
    [tx.businessId, revisionId],
  );
  if (named === undefined || named.page_url === null || named.path === null) {
    return { code: 'NOT_FOUND' };
  }
  const page = { partyId: named.party_id, pageUrl: named.page_url, path: named.path };
  const bound = await holdBoundPage(tx, page);
  const review = await lockCoveredReview(tx, named.id, covering);
  if (review === undefined) return { code: 'NOT_FOUND' };
  if (!bound) return { code: 'PAGE_OUTSIDE_HOLDER_SITE' };
  const asked = await tx.query<{ readonly id: string }>(
    `insert into public.review_captures
       (business_id, id, revision_id, width, asked_by_actor_id, asked_by_person_id)
     select $1, gen_random_uuid(), $2, w.width, $3, $4 from unnest($5::int[]) as w (width)
     on conflict (business_id, revision_id, width) do nothing
     returning id`,
    [tx.businessId, revisionId, writer.actorId, writer.personId, [...CAPTURE_WIDTHS]],
  );
  if (asked.length === 0) return { code: 'CAPTURE_ALREADY_ASKED' };
  return { review, captureIds: asked.map((row) => row.id) };
}

/**
 * One review the caller's grant covers at its holder, locked for the caller's write, or
 * undefined: absent, in another business, or not covered are one answer. Judged in the locking
 * read and again in a fresh statement once the covering grants are held.
 */
export async function lockCoveredReview(
  tx: TenantQuery,
  id: string,
  covering: Covering,
): Promise<Review | undefined> {
  const parameters = [tx.businessId, ...coveringParameters(covering), id];
  const [row] = await tx.query<ReviewRow>(
    `${EFFECTIVE_AT}
     select ${REVIEW_COLUMNS} from public.reviews c
      where c.business_id = $1 and c.id = $6 and ${COVERED}
      for update of c`,
    parameters,
  );
  if (row === undefined) return undefined;
  await holdCoveringGrants(tx, covering);
  const still = await tx.query<{ readonly id: string }>(
    `${EFFECTIVE_AT}
     select c.id from public.reviews c where c.business_id = $1 and c.id = $6 and ${COVERED}`,
    parameters,
  );
  return still.length === 0 ? undefined : reviewFrom(row);
}
