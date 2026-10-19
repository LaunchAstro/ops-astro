// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's reads (#2011): one review with its revisions and their captures, the latest paired
// with the one before it, and its pins (#2012); and one landed picture's bytes. Each filters
// by the caller's grant at the review's holder inside the query (`covering.ts`), so a party
// grant reads no other client's review and a picture of another business or out of reach is
// one answer with a picture that is not there. The revisions, captures and pins, and a
// picture's bytes, are read in statements of their own, so the grant is judged again after the
// last of them (`stillCovered`, `pictureCovered`): a grant revoked or run out meanwhile reads
// nothing written since, and no bytes (S2061-1, S2147-3).

import type { TenantQuery } from '../tenancy/database.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters, type Covering } from '../site/covering.ts';
import type { CaptureWidth, Review } from './reviews.ts';
import { readPins, type PinView } from './pins.ts';
import { DATABASE_STORAGE } from './storage.ts';

export interface CaptureView {
  readonly width: CaptureWidth;
  readonly state: 'requested' | 'claimed' | 'landed';
  readonly pictureId: string | null;
  readonly pictureDigest: string | null;
  readonly observation: Readonly<Record<string, unknown>> | null;
}

export interface RevisionView {
  readonly revisionId: string;
  readonly number: number;
  readonly digest: string;
  readonly captures: readonly CaptureView[];
}

export interface ReviewView extends Omit<Review, 'id' | 'revisionCount'> {
  readonly reviewId: string;
  readonly revisions: readonly RevisionView[];
  /** The revision under review, the latest; null only for a review with none. */
  readonly after: RevisionView | null;
  /** The revision before it, to compare at each width; null for a first revision. */
  readonly before: RevisionView | null;
  readonly pins: readonly PinView[];
}

/** One review the caller's grant covers, its revisions in number order, captures by width. */
export async function readCoveredReview(
  tx: TenantQuery,
  reviewId: string,
  covering: Covering,
): Promise<ReviewView | undefined> {
  const [review] = await tx.query<{
    readonly task_id: string;
    readonly party_id: string | null;
    readonly kind: 'page' | 'media';
    readonly page_url: string | null;
    readonly path: string | null;
  }>(
    `${EFFECTIVE_AT}
     select c.task_id, c.party_id, c.kind, c.page_url, c.path from public.reviews c
      where c.business_id = $1 and c.id = $6 and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), reviewId],
  );
  if (review === undefined) return undefined;
  const revisions = await tx.query<{
    readonly id: string;
    readonly number: number;
    readonly digest: string;
  }>(
    `select id, number, digest from public.review_revisions
      where business_id = $1 and review_id = $2 order by number`,
    [tx.businessId, reviewId],
  );
  const captures = await capturesOf(tx, reviewId);
  const views = revisions.map((revision) => ({
    revisionId: revision.id,
    number: revision.number,
    digest: revision.digest,
    captures: captures.get(revision.id) ?? [],
  }));
  const pins = await readPins(tx, { reviewId, taskId: review.task_id });
  if (!(await stillCovered(tx, covering, reviewId))) return undefined;
  return {
    reviewId,
    taskId: review.task_id,
    partyId: review.party_id,
    kind: review.kind,
    pageUrl: review.page_url,
    path: review.path,
    revisions: views,
    after: views.at(-1) ?? null,
    before: views.at(-2) ?? null,
    pins,
  };
}

/** Every capture of the review's revisions, widest first, by the revision it is of. */
async function capturesOf(
  tx: TenantQuery,
  reviewId: string,
): Promise<ReadonlyMap<string, readonly CaptureView[]>> {
  const rows = await tx.query<{
    readonly revision_id: string;
    readonly width: CaptureWidth;
    readonly state: CaptureView['state'];
    readonly picture_id: string | null;
    readonly picture_digest: string | null;
    readonly observation: Readonly<Record<string, unknown>> | null;
  }>(
    `select k.revision_id, k.width, k.state, k.picture_id, k.picture_digest, k.observation
       from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
      where k.business_id = $1 and v.review_id = $2
      order by k.width desc`,
    [tx.businessId, reviewId],
  );
  const byRevision = new Map<string, CaptureView[]>();
  for (const row of rows) {
    const captures = byRevision.get(row.revision_id) ?? [];
    captures.push({
      width: row.width,
      state: row.state,
      pictureId: row.picture_id,
      pictureDigest: row.picture_digest,
      observation: row.observation,
    });
    byRevision.set(row.revision_id, captures);
  }
  return byRevision;
}

/**
 * Whether the caller's grant still covers the review at its holder, in a statement of its own.
 * Asked after the read's last part, so a grant revoked or expired meanwhile reads nothing.
 */
async function stillCovered(
  tx: TenantQuery,
  covering: Covering,
  reviewId: string,
): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `${EFFECTIVE_AT}
     select c.id from public.reviews c
      where c.business_id = $1 and c.id = $6::uuid and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), reviewId],
  );
  return rows.length > 0;
}

export interface ReviewPicture {
  readonly pictureId: string;
  readonly digest: string;
  readonly byteCount: number;
  /** The bytes, base64. */
  readonly body: string;
}

/**
 * A landed picture whose review the caller's grant covers, as base64 with its digest. The bytes
 * are read from storage in a statement of their own, so the grant is asked again after them: a
 * grant revoked or run out meanwhile reads no bytes (S2147-3).
 */
export async function readCoveredPicture(
  tx: TenantQuery,
  pictureId: string,
  covering: Covering,
): Promise<ReviewPicture | undefined> {
  if (!(await pictureCovered(tx, covering, pictureId))) return undefined;
  const stored = await DATABASE_STORAGE.get(tx, pictureId);
  if (stored === undefined) return undefined;
  if (!(await pictureCovered(tx, covering, pictureId))) return undefined;
  return {
    pictureId,
    digest: stored.digest,
    byteCount: stored.byteCount,
    body: Buffer.from(stored.body).toString('base64'),
  };
}

/** Whether the caller's grant covers the review a landed picture is of, in its own statement. */
async function pictureCovered(
  tx: TenantQuery,
  covering: Covering,
  pictureId: string,
): Promise<boolean> {
  const rows = await tx.query<{ readonly picture_id: string }>(
    `${EFFECTIVE_AT}
     select k.picture_id from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where k.business_id = $1 and k.picture_id = $6 and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), pictureId],
  );
  return rows.length > 0;
}
