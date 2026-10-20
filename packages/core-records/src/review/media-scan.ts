// SPDX-License-Identifier: AGPL-3.0-only
//
// U89's quarantine (#2039, C73): an admitted asset waits quarantined until a
// scanner's answer lands, and nothing signs a read of it before that answer
// is passed. The scanner sits behind one port; the product ships no engine,
// so without one wired every asset stays quarantined. A failed scan removes
// the stored object. The land is the system's own step under the scan's
// lease, judged by the business's transaction alone; the sign is the
// caller's, judged at the review's holder by the caller's grant.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Covering } from '../site/covering.ts';
import { lockCoveredReview } from './reviews.ts';
import type { ObjectTransfers, SignedTransfer } from './storage.ts';
import { mediaRefusal, type MediaRefusal } from './media.ts';
import { MOST_RANGE_BYTES, rangeReader } from './upload-contract.ts';

export type ScanVerdict = 'passed' | 'failed';

/** The longest a playback or delivery read is signed for. */
export const MOST_READ_LIFE_SECONDS = 3600;

/** A malware scanner: a stored object's bytes in, in order, and its verdict out. */
export interface MediaScanner {
  readonly engine: string;
  scan(chunks: AsyncIterable<Uint8Array>): Promise<ScanVerdict>;
}

export type SignRefusal =
  | MediaRefusal
  | {
      readonly code:
        | 'LIFE_OUT_OF_RANGE'
        | 'ASSET_NOT_COMPLETE'
        | 'ASSET_REFUSED'
        | 'ASSET_QUARANTINED'
        | 'ASSET_SCAN_FAILED';
    };

interface QuarantinedRow {
  readonly object_key: string;
  readonly declared_bytes: string;
}

/** A completed object's bytes in bounded ranges, in order, each checked by `rangeReader`. */
export async function* objectChunks(
  store: ObjectTransfers,
  key: string,
  byteCount: number,
): AsyncGenerator<Uint8Array> {
  const read = rangeReader(store, key, byteCount);
  for (let from = 0; from < byteCount; from += MOST_RANGE_BYTES)
    // oxlint-disable-next-line no-await-in-loop -- the scanner takes the bytes in order
    yield await read(from, Math.min(MOST_RANGE_BYTES, byteCount - from));
}

/** A quarantined asset's object, for the scan to read; another state or business: none. */
export async function quarantinedObject(
  tx: TenantQuery,
  assetId: string,
): Promise<{ readonly key: string; readonly byteCount: number } | undefined> {
  const [row] = await tx.query<QuarantinedRow>(
    `select object_key, declared_bytes::text from public.review_media_assets
      where business_id = $1 and id = $2 and scan_state = 'quarantined'`,
    [tx.businessId, assetId],
  );
  return row && { key: row.object_key, byteCount: Number(row.declared_bytes) };
}

/**
 * Land a scanner's verdict on a quarantined asset, locked first so one verdict lands once. A
 * failed asset's stored object is removed. An asset of another business, or one not quarantined,
 * is not there.
 */
export async function landMediaScan(
  tx: TenantQuery,
  input: { readonly assetId: string; readonly engine: string; readonly verdict: ScanVerdict },
  store: ObjectTransfers,
): Promise<{ readonly assetId: string; readonly verdict: ScanVerdict } | MediaRefusal> {
  const [row] = await tx.query<QuarantinedRow>(
    `select object_key, declared_bytes::text from public.review_media_assets
      where business_id = $1 and id = $2 and scan_state = 'quarantined'
        for update`,
    [tx.businessId, input.assetId],
  );
  if (row === undefined) return mediaRefusal('NOT_FOUND');
  if (input.verdict === 'failed' && (await store.remove(row.object_key)) !== true)
    return mediaRefusal('STORE_REFUSED');
  await tx.query(
    `update public.review_media_assets
        set scan_state = $3, scan_engine = $4, scanned_at = now(), updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, input.assetId, input.verdict, input.engine],
  );
  return { assetId: input.assetId, verdict: input.verdict };
}

/**
 * A GET of an asset signed for `lifeSeconds`, for playback or delivery, only once its scan has
 * passed: a life that is not a whole number of seconds from one to `MOST_READ_LIFE_SECONDS` is
 * refused before anything is read, then the review is judged by the caller's grant under its
 * lock, then the asset's own state read in the same transaction. Each other state is refused by
 * its name.
 */
export async function signMediaRead(
  tx: TenantQuery,
  input: { readonly assetId: string; readonly covering: Covering; readonly lifeSeconds: number },
  store: ObjectTransfers,
): Promise<SignedTransfer | SignRefusal> {
  const life = input.lifeSeconds;
  if (!Number.isInteger(life) || life < 1 || life > MOST_READ_LIFE_SECONDS)
    return { code: 'LIFE_OUT_OF_RANGE' };
  const [named] = await tx.query<{ readonly review_id: string }>(
    'select review_id from public.review_media_assets where business_id = $1 and id = $2',
    [tx.businessId, input.assetId],
  );
  if (named === undefined) return mediaRefusal('NOT_FOUND');
  const review = await lockCoveredReview(tx, named.review_id, input.covering);
  if (review === undefined) return mediaRefusal('NOT_FOUND');
  const [asset] = await tx.query<{
    readonly object_key: string;
    readonly refusal: string | null;
    readonly scan_state: 'quarantined' | 'passed' | 'failed' | null;
  }>(
    `select object_key, refusal, scan_state from public.review_media_assets
      where business_id = $1 and id = $2 and review_id = $3
        for share`,
    [tx.businessId, input.assetId, review.id],
  );
  if (asset === undefined) return mediaRefusal('NOT_FOUND');
  if (asset.refusal !== null) return { code: 'ASSET_REFUSED' };
  if (asset.scan_state === null) return { code: 'ASSET_NOT_COMPLETE' };
  if (asset.scan_state === 'quarantined') return { code: 'ASSET_QUARANTINED' };
  if (asset.scan_state === 'failed') return { code: 'ASSET_SCAN_FAILED' };
  const signed = await store.signRead(asset.object_key, input.lifeSeconds);
  return 'refused' in signed ? mediaRefusal('STORE_REFUSED') : signed;
}
