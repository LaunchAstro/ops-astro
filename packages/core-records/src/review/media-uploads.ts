// SPDX-License-Identifier: AGPL-3.0-only
//
// U89's media store (#2038): the calls on an upload after its start. Each is
// judged at the review's holder by the caller's grant inside the locking
// query (`lockCoveredReview`), so another client's or business's upload is
// one that is not there. Nothing is a revision until the store's own size and
// digest match the declared ones; a mismatch removes the object and keeps no
// revision. A completed asset is admitted by the upload contract (#2039):
// quarantined until its scan lands, or refused with its object removed.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Covering } from '../site/covering.ts';
import { addRevision, lockCoveredReview, type Review, type ReviewWriter } from './reviews.ts';
import type { ObjectTransfers, StoredPart } from './storage.ts';
import { admitCompleted, HostileStoreAnswer, type Admission } from './upload-contract.ts';
import {
  mediaRefusal,
  MOST_PARTS_SIGNED,
  PART_LIFE_SECONDS,
  partCountOf,
  type DeclaredAsset,
  type MediaRefusal,
  type SignedPart,
} from './media.ts';

interface AssetRow {
  readonly id: string;
  readonly review_id: string;
  readonly planned_revision_id: string;
  readonly kind: DeclaredAsset['kind'];
  readonly declared_type: string;
  readonly declared_codec: string | null;
  readonly declared_bytes: string;
  readonly declared_digest: string;
  readonly object_key: string;
  readonly upload_id: string;
  readonly state: 'started' | 'completed' | 'abandoned';
}

/**
 * A started upload whose review the caller's grant covers at its holder: the review locked and
 * judged first (`lockCoveredReview`), then the asset row locked. Absent, in another business, not
 * covered, or no longer started: one refusal each, naming nothing of the upload.
 */
async function lockStartedUpload(
  tx: TenantQuery,
  assetId: string,
  covering: Covering,
): Promise<{ readonly review: Review; readonly asset: AssetRow } | MediaRefusal> {
  const [named] = await tx.query<{ readonly review_id: string }>(
    'select review_id from public.review_media_assets where business_id = $1 and id = $2',
    [tx.businessId, assetId],
  );
  if (named === undefined) return mediaRefusal('NOT_FOUND');
  const review = await lockCoveredReview(tx, named.review_id, covering);
  if (review === undefined) return mediaRefusal('NOT_FOUND');
  const [asset] = await tx.query<AssetRow>(
    `select id, review_id, planned_revision_id, kind, declared_type, declared_codec,
            declared_bytes::text, declared_digest, object_key, upload_id, state
       from public.review_media_assets
      where business_id = $1 and id = $2 and review_id = $3
        for update`,
    [tx.businessId, assetId, review.id],
  );
  if (asset === undefined) return mediaRefusal('NOT_FOUND');
  if (asset.state !== 'started') return mediaRefusal('UPLOAD_NOT_OPEN');
  return { review, asset };
}

const missingParts = (asset: AssetRow, held: readonly StoredPart[], partBytes: number) => {
  const have = new Set(held.map((part) => part.partNumber));
  const count = partCountOf(Number(asset.declared_bytes), partBytes);
  return Array.from({ length: count }, (_, index) => index + 1).filter((n) => !have.has(n));
};

/**
 * The parts the store already holds, and signed URLs for up to `want` of the parts it does not,
 * so a caller back from a disconnect sends only the rest.
 */
export async function mediaUploadParts(
  tx: TenantQuery,
  input: { readonly assetId: string; readonly covering: Covering; readonly want: number },
  store: ObjectTransfers,
): Promise<
  { readonly held: readonly StoredPart[]; readonly signed: readonly SignedPart[] } | MediaRefusal
> {
  const locked = await lockStartedUpload(tx, input.assetId, input.covering);
  if ('code' in locked) return locked;
  const { asset } = locked;
  const held = await store.listParts(asset.object_key, asset.upload_id);
  if ('refused' in held) return mediaRefusal('STORE_REFUSED');
  const want = Math.min(Math.max(1, Math.trunc(input.want)), MOST_PARTS_SIGNED);
  const next = missingParts(asset, held, store.partBytes).slice(0, want);
  const transfers = await Promise.all(
    next.map((partNumber) =>
      store.signPart(asset.object_key, asset.upload_id, partNumber, PART_LIFE_SECONDS),
    ),
  );
  const signed: SignedPart[] = [];
  for (const [index, transfer] of transfers.entries()) {
    if ('refused' in transfer) return mediaRefusal('STORE_REFUSED');
    signed.push({ partNumber: next[index]!, url: transfer.url, expiresAt: transfer.expiresAt });
  }
  return { held, signed };
}

/**
 * Complete an upload whose parts the store holds, then compare the store's size and digest with
 * the declared ones, then run the upload contract on the stored bytes. A mismatch, or a store
 * answering a range with another length, removes the stored object and marks the upload
 * abandoned. Otherwise the revision is written, numbered under the review's lock, with the
 * asset's digest, and the asset is admitted as the contract says: quarantined with its probe, or
 * refused with its reason and its object removed.
 */
export async function completeMediaUpload(
  tx: TenantQuery,
  input: { readonly assetId: string; readonly covering: Covering; readonly writer: ReviewWriter },
  store: ObjectTransfers,
): Promise<
  | {
      readonly reviewId: string;
      readonly revisionId: string;
      readonly number: number;
      readonly digest: string;
      readonly admission: Admission;
    }
  | MediaRefusal
> {
  const locked = await lockStartedUpload(tx, input.assetId, input.covering);
  if ('code' in locked) return locked;
  const { review, asset } = locked;
  const declared = declaredOf(asset);
  const stored = await completeAtStore(asset, store);
  if ('code' in stored) return stored;
  if (stored.byteCount !== declared.byteCount || stored.digest !== asset.declared_digest) {
    await store.remove(asset.object_key);
    await abandonUpload(tx, asset.id);
    return mediaRefusal('UPLOAD_MISMATCH');
  }
  const admission = await admitted(store, asset.object_key, declared);
  if (admission === undefined) {
    await store.remove(asset.object_key);
    await abandonUpload(tx, asset.id);
    return mediaRefusal('STORE_ANSWER_REFUSED');
  }
  if (admission.verdict === 'refused' && (await store.remove(asset.object_key)) !== true)
    return mediaRefusal('STORE_REFUSED');
  const revision = await addRevision(
    tx,
    review,
    { id: asset.planned_revision_id, digest: stored.digest, sourceRevision: null },
    input.writer,
  );
  await admitUpload(tx, asset.id, revision.id, admission);
  return {
    reviewId: review.id,
    revisionId: revision.id,
    number: revision.number,
    digest: revision.digest,
    admission,
  };
}

const declaredOf = (asset: AssetRow) => ({
  kind: asset.kind,
  type: asset.declared_type,
  codec: asset.declared_codec,
  byteCount: Number(asset.declared_bytes),
});

/** The store's own size and digest of an upload it holds every part of. */
async function completeAtStore(
  asset: AssetRow,
  store: ObjectTransfers,
): Promise<{ readonly byteCount: number; readonly digest: string } | MediaRefusal> {
  const held = await store.listParts(asset.object_key, asset.upload_id);
  if ('refused' in held) return mediaRefusal('STORE_REFUSED');
  if (missingParts(asset, held, store.partBytes).length > 0)
    return mediaRefusal('UPLOAD_INCOMPLETE');
  const partNumbers = held.map((part) => part.partNumber).toSorted((a, b) => a - b);
  const stored = await store.complete(asset.object_key, asset.upload_id, partNumbers);
  return 'refused' in stored ? mediaRefusal('STORE_REFUSED') : stored;
}

/** The contract's admission, or undefined when the store answered a range with another length. */
async function admitted(
  store: ObjectTransfers,
  key: string,
  declared: Parameters<typeof admitCompleted>[2],
): Promise<Admission | undefined> {
  try {
    return await admitCompleted(store, key, declared);
  } catch (error) {
    if (error instanceof HostileStoreAnswer) return undefined;
    throw error;
  }
}

/** Abort a started upload at the store and mark it abandoned. */
export async function abandonMediaUpload(
  tx: TenantQuery,
  input: { readonly assetId: string; readonly covering: Covering },
  store: ObjectTransfers,
): Promise<{ readonly reviewId: string } | MediaRefusal> {
  const locked = await lockStartedUpload(tx, input.assetId, input.covering);
  if ('code' in locked) return locked;
  const aborted = await store.abort(locked.asset.object_key, locked.asset.upload_id);
  if (aborted !== true) return mediaRefusal('STORE_REFUSED');
  await abandonUpload(tx, locked.asset.id);
  return { reviewId: locked.review.id };
}

async function abandonUpload(tx: TenantQuery, assetId: string): Promise<void> {
  await tx.query(
    `update public.review_media_assets set state = 'abandoned', updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, assetId],
  );
}

/** The completed asset named with its revision and admitted as the contract said. */
async function admitUpload(
  tx: TenantQuery,
  assetId: string,
  revisionId: string,
  admission: Admission,
): Promise<void> {
  const probe = admission.verdict === 'quarantined' ? admission.probe : null;
  await tx.query(
    `update public.review_media_assets
        set state = 'completed', revision_id = $3, refusal = $4, scan_state = $5,
            probe_codec = $6, probe_fps_num = $7, probe_fps_den = $8, probe_timecode = $9,
            probe_duration = $10, probe_timescale = $11, updated_at = now()
      where business_id = $1 and id = $2`,
    [
      tx.businessId,
      assetId,
      revisionId,
      admission.verdict === 'refused' ? admission.refusal : null,
      admission.verdict === 'quarantined' ? 'quarantined' : null,
      probe?.codec ?? null,
      probe?.fps.num ?? null,
      probe?.fps.den ?? null,
      probe?.startTimecode ?? null,
      probe?.duration ?? null,
      probe?.timescale ?? null,
    ],
  );
}
