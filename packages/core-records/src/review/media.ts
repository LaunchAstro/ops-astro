// SPDX-License-Identifier: AGPL-3.0-only
//
// U89's media store records (#2038, migration 20261020052900): a media
// review is a review (`kind = 'media'`, one per task) whose revisions carry
// an asset in place of page captures, and a revision's digest is its asset's.
//
// An upload starts with what the caller declares (kind, type, size, codec,
// digest) and an open multipart upload at the store, keyed by ids only:
// `business/review/revision/asset`, the revision id planned at the start. The
// caller sends the parts straight to the store at URLs the store signs, asks
// again after a disconnect for what the store holds, and completes. Nothing is
// a revision until the store's own size and digest match the declared ones
// (`media-uploads.ts`, the calls after the start), and the upload contract
// (#2039, `upload-contract.ts`) refuses a type its kind does not take or a
// size past its kind's limit before the store is asked anything.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  holderOfTask,
  REVIEW_COLUMNS,
  reviewFrom,
  type Review,
  type ReviewRow,
  type ReviewWriter,
} from './reviews.ts';
import type { ObjectTransfers } from './storage.ts';
import { refusalAtStart } from './upload-contract.ts';

export const MEDIA_KINDS = ['video', 'audio', 'image', 'pdf'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** The preset a camera original is sent back to: what every browser plays. */
export const REVIEW_RENDER_PRESET = 'review render: H.264 or HEVC video in an MP4 file';
/** RFC 6381 codec names for H.264 (`avc1`) and HEVC (`hvc1`, `hev1`). */
const REVIEW_RENDER_CODEC = /^(?:avc1|hvc1|hev1)(?:\.[0-9A-Za-z.]+)?$/u;

/** How long a signed part URL lives. */
export const PART_LIFE_SECONDS = 300;
/** The most part URLs one ask signs. */
export const MOST_PARTS_SIGNED = 16;

export interface DeclaredAsset {
  readonly kind: MediaKind;
  readonly type: string;
  readonly byteCount: number;
  readonly codec: string | null;
  /** `sha256:` and the hex digest of the whole file. */
  readonly digest: string;
}

export type MediaRefusal = {
  readonly code:
    | 'NOT_FOUND'
    | 'CAMERA_ORIGINAL'
    | 'UPLOAD_NOT_OPEN'
    | 'UPLOAD_INCOMPLETE'
    | 'UPLOAD_MISMATCH'
    | 'STORE_REFUSED'
    | 'TYPE_UNSUPPORTED'
    | 'TOO_LARGE_FOR_CLASS'
    | 'STORE_ANSWER_REFUSED';
};

export interface MediaUpload {
  readonly reviewId: string;
  readonly assetId: string;
  readonly partCount: number;
}

export interface SignedPart {
  readonly partNumber: number;
  readonly url: string;
  readonly expiresAt: string;
}

/** A video declared as anything but H.264 or HEVC in an MP4 is a camera original. */
export const isReviewRender = (declared: DeclaredAsset): boolean =>
  declared.kind !== 'video' ||
  (declared.type === 'video/mp4' &&
    declared.codec !== null &&
    REVIEW_RENDER_CODEC.test(declared.codec));

export const mediaObjectKey = (
  businessId: string,
  reviewId: string,
  revisionId: string,
  assetId: string,
): string => [businessId, reviewId, revisionId, assetId].join('/');

export const partCountOf = (byteCount: number, partBytes: number): number =>
  Math.max(1, Math.ceil(byteCount / partBytes));

export const mediaRefusal = (code: MediaRefusal['code']): MediaRefusal => ({ code });

/** The task's media review, inserted if there is none, then locked for its next number. */
async function lockMediaReview(
  tx: TenantQuery,
  taskId: string,
  partyId: string | null,
  writer: ReviewWriter,
): Promise<Review> {
  await tx.query(
    `insert into public.reviews
       (business_id, id, task_id, party_id, kind, opened_by_actor_id, opened_by_person_id,
        delegation_id)
     values ($1, $2, $3, $4, 'media', $5, $6, $7)
     on conflict (business_id, task_id) where kind = 'media' do nothing`,
    [
      tx.businessId,
      randomUUID(),
      taskId,
      partyId,
      writer.actorId,
      writer.personId,
      writer.delegationId,
    ],
  );
  const [row] = await tx.query<ReviewRow>(
    `select ${REVIEW_COLUMNS} from public.reviews c
      where c.business_id = $1 and c.task_id = $2 and c.kind = 'media'
        for update of c`,
    [tx.businessId, taskId],
  );
  if (row === undefined) throw new Error('lockMediaReview: the review inserted or found above');
  return reviewFrom(row);
}

/**
 * Start an upload of a declared asset on the task's media review. A camera original, a type its
 * kind does not take and a size past its kind's limit are refused before the store is asked
 * anything; the task is read under a share lock for its holder, as a
 * page review's open reads it. The caller's grant at that holder is the command's to judge.
 */
export async function startMediaUpload(
  tx: TenantQuery,
  input: {
    readonly taskId: string;
    readonly declared: DeclaredAsset;
    readonly writer: ReviewWriter;
  },
  store: ObjectTransfers,
): Promise<MediaUpload | MediaRefusal> {
  const { declared, writer } = input;
  if (!isReviewRender(declared)) return mediaRefusal('CAMERA_ORIGINAL');
  const refused = refusalAtStart(declared);
  if (refused !== null) return mediaRefusal(refused);
  const holder = await holderOfTask(tx, input.taskId);
  if (holder === undefined) return mediaRefusal('NOT_FOUND');
  const review = await lockMediaReview(tx, input.taskId, holder.partyId, writer);
  const assetId = randomUUID();
  const revisionId = randomUUID();
  const key = mediaObjectKey(tx.businessId, review.id, revisionId, assetId);
  const opened = await store.open(key);
  if ('refused' in opened) return mediaRefusal('STORE_REFUSED');
  await tx.query(
    `insert into public.review_media_assets
       (business_id, id, review_id, planned_revision_id, kind, declared_type, declared_bytes,
        declared_codec, declared_digest, object_key, upload_id, created_by_actor_id,
        created_by_person_id, delegation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      tx.businessId,
      assetId,
      review.id,
      revisionId,
      declared.kind,
      declared.type,
      declared.byteCount,
      declared.codec,
      declared.digest,
      key,
      opened.uploadId,
      writer.actorId,
      writer.personId,
      writer.delegationId,
    ],
  );
  return {
    reviewId: review.id,
    assetId,
    partCount: partCountOf(declared.byteCount, store.partBytes),
  };
}
