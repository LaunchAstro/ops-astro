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
import type { ObjectTransfers, SignedTransfer } from './storage.ts';
import { mediaRefusal, type MediaRefusal } from './media.ts';
import { MOST_RANGE_BYTES, rangeReader } from './upload-contract.ts';

export type ScanVerdict = 'passed' | 'failed';

/** A malware scanner: a stored object's bytes in, in order, and its verdict out. */
export interface MediaScanner {
  readonly engine: string;
  scan(chunks: AsyncIterable<Uint8Array>): Promise<ScanVerdict>;
}

export type SignRefusal =
  | MediaRefusal
  | {
      readonly code:
        'ASSET_NOT_COMPLETE' | 'ASSET_REFUSED' | 'ASSET_QUARANTINED' | 'ASSET_SCAN_FAILED';
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

export async function landMediaScan(
  tx: TenantQuery,
  input: { readonly assetId: string; readonly engine: string; readonly verdict: ScanVerdict },
  _store: ObjectTransfers,
): Promise<{ readonly assetId: string; readonly verdict: ScanVerdict } | MediaRefusal> {
  await tx.query(
    `update public.review_media_assets
        set scan_state = $3, scan_engine = $4, scanned_at = now(), updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, input.assetId, input.verdict, input.engine],
  );
  return { assetId: input.assetId, verdict: input.verdict };
}

export async function signMediaRead(
  tx: TenantQuery,
  input: { readonly assetId: string; readonly covering: Covering; readonly lifeSeconds: number },
  store: ObjectTransfers,
): Promise<SignedTransfer | SignRefusal> {
  const [asset] = await tx.query<{ readonly object_key: string }>(
    'select object_key from public.review_media_assets where business_id = $1 and id = $2',
    [tx.businessId, input.assetId],
  );
  if (asset === undefined) return mediaRefusal('NOT_FOUND');
  const signed = await store.signRead(asset.object_key, input.lifeSeconds);
  return 'refused' in signed ? mediaRefusal('STORE_REFUSED') : signed;
}
