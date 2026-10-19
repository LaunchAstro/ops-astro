// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's reads (#2011): one review with its revisions and captures, and one
// landed picture's bytes. Each filters by the caller's grant at the review's
// holder inside the query (`covering.ts`), so a party grant reads no other
// client's review and a picture of another business or out of reach is one
// answer with a picture that is not there.

import type { TenantQuery } from '../tenancy/database.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters, type Covering } from '../site/covering.ts';
import type { CaptureWidth, Review } from './reviews.ts';
import { DATABASE_STORAGE } from './storage.ts';
import type { MediaKind } from './media.ts';
import type { ContractRefusal } from './upload-contract.ts';
import type { MediaProbe } from './mp4-probe.ts';

export interface CaptureView {
  readonly width: CaptureWidth;
  readonly state: 'requested' | 'claimed' | 'landed';
  readonly pictureId: string | null;
  readonly pictureDigest: string | null;
  readonly observation: Readonly<Record<string, unknown>> | null;
}

/** A media revision's asset (#2039): whether it can play, and why not when it cannot. */
export interface MediaView {
  readonly assetId: string;
  readonly kind: MediaKind;
  readonly playable: boolean;
  readonly why: 'quarantined' | 'scan_failed' | ContractRefusal | null;
  readonly probe: MediaProbe | null;
}

export interface RevisionView {
  readonly revisionId: string;
  readonly number: number;
  readonly digest: string;
  readonly captures: readonly CaptureView[];
  /** A media review's revisions only. */
  readonly media?: MediaView;
}

export interface ReviewView extends Omit<Review, 'id' | 'revisionCount'> {
  readonly reviewId: string;
  readonly revisions: readonly RevisionView[];
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
  const media =
    review.kind === 'media' ? await mediaOf(tx, reviewId) : new Map<string, MediaView>();
  return {
    reviewId,
    taskId: review.task_id,
    partyId: review.party_id,
    kind: review.kind,
    pageUrl: review.page_url,
    path: review.path,
    revisions: revisions.map((revision) =>
      withMedia(
        {
          revisionId: revision.id,
          number: revision.number,
          digest: revision.digest,
          captures: captures.get(revision.id) ?? [],
        },
        media.get(revision.id),
      ),
    ),
  };
}

const withMedia = (view: RevisionView, media: MediaView | undefined): RevisionView =>
  media === undefined ? view : { ...view, media };

interface MediaRow {
  readonly id: string;
  readonly revision_id: string;
  readonly kind: MediaKind;
  readonly refusal: ContractRefusal | null;
  readonly scan_state: 'quarantined' | 'passed' | 'failed' | null;
  readonly probe_codec: string | null;
  readonly probe_fps_num: number;
  readonly probe_fps_den: number;
  readonly probe_timecode: string;
  readonly probe_duration: string;
  readonly probe_timescale: number;
}

const WHY_NOT_PLAYABLE = {
  quarantined: 'quarantined',
  failed: 'scan_failed',
  passed: null,
} as const;

/** A completed asset as the read says it: playable once passed, else why not. */
const mediaViewOf = (row: MediaRow): MediaView => ({
  assetId: row.id,
  kind: row.kind,
  playable: row.scan_state === 'passed',
  why: row.refusal ?? (row.scan_state === null ? null : WHY_NOT_PLAYABLE[row.scan_state]),
  // The probe's columns are all set or none (`review_media_assets_probe_whole`).
  probe:
    row.probe_codec === null
      ? null
      : {
          codec: row.probe_codec,
          fps: { num: row.probe_fps_num, den: row.probe_fps_den },
          startTimecode: row.probe_timecode,
          duration: Number(row.probe_duration),
          timescale: row.probe_timescale,
        },
});

/** Each completed asset of a media review, by the revision it is. */
async function mediaOf(tx: TenantQuery, reviewId: string): Promise<ReadonlyMap<string, MediaView>> {
  const rows = await tx.query<MediaRow>(
    `select id, revision_id, kind, refusal, scan_state, probe_codec, probe_fps_num, probe_fps_den,
            probe_timecode, probe_duration::text, probe_timescale
       from public.review_media_assets
      where business_id = $1 and review_id = $2 and state = 'completed'`,
    [tx.businessId, reviewId],
  );
  return new Map(rows.map((row) => [row.revision_id, mediaViewOf(row)]));
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

export interface ReviewPicture {
  readonly pictureId: string;
  readonly digest: string;
  readonly byteCount: number;
  /** The bytes, base64. */
  readonly body: string;
}

/** A landed picture whose review the caller's grant covers, as base64 with its digest. */
export async function readCoveredPicture(
  tx: TenantQuery,
  pictureId: string,
  covering: Covering,
): Promise<ReviewPicture | undefined> {
  const reached = await tx.query<{ readonly picture_id: string }>(
    `${EFFECTIVE_AT}
     select k.picture_id from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where k.business_id = $1 and k.picture_id = $6 and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), pictureId],
  );
  if (reached.length === 0) return undefined;
  const stored = await DATABASE_STORAGE.get(tx, pictureId);
  if (stored === undefined) return undefined;
  return {
    pictureId,
    digest: stored.digest,
    byteCount: stored.byteCount,
    body: Buffer.from(stored.body).toString('base64'),
  };
}
