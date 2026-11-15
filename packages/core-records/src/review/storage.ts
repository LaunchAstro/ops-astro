// SPDX-License-Identifier: AGPL-3.0-only
//
// The storage seam (C35, #2011): bytes kept by id, never by path, in the
// business whose transaction asks. One provider today, the bounded database
// one over `storage_objects`, so a picture lands in the same transaction as
// the capture row that names it. The media unit (U89, #2038) adds the
// multipart transfers an object store answers (`ObjectTransfers`), and the
// upload contract (#2039) a signed read and a bounded range read of a
// completed object; the database provider refuses each of them by name.

import { createHash, randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

/** The database provider's cap, as `storage_objects_bounded` holds it. */
export const MOST_STORED_BYTES: number = 512 * 1024;

export interface StoredObject {
  readonly id: string;
  /** `sha256:` and the hex digest of the bytes. */
  readonly digest: string;
  readonly byteCount: number;
}

export type StoreRefusal = { readonly refused: 'OBJECT_EMPTY' | 'OBJECT_TOO_LARGE' };

/** A URL signed for one object, one part and one method, until it expires. */
export interface SignedTransfer {
  readonly url: string;
  readonly method: 'PUT' | 'GET';
  readonly expiresAt: string;
}

export interface StoredPart {
  readonly partNumber: number;
  readonly byteCount: number;
}

export type TransferRefusal = {
  readonly refused: 'TRANSFERS_UNSUPPORTED' | 'UPLOAD_UNKNOWN' | 'STORE_UNAVAILABLE';
};

/**
 * A multipart upload by object key, straight from the caller to the store: the store keeps the
 * parts, signs each part's URL for one object, part and method, and reports what it completed.
 * The credential that signs stays with the store's side of this port, never in an answer.
 */
export interface ObjectTransfers {
  /** The size of every part but the last. */
  readonly partBytes: number;
  open(key: string): Promise<{ readonly uploadId: string } | TransferRefusal>;
  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    lifeSeconds: number,
  ): Promise<SignedTransfer | TransferRefusal>;
  listParts(key: string, uploadId: string): Promise<readonly StoredPart[] | TransferRefusal>;
  /** The parts joined in number order, and what the store holds: its size and digest. */
  complete(
    key: string,
    uploadId: string,
    partNumbers: readonly number[],
  ): Promise<{ readonly byteCount: number; readonly digest: string } | TransferRefusal>;
  abort(key: string, uploadId: string): Promise<boolean | TransferRefusal>;
  /** A completed object removed, as a refused completion leaves none. */
  remove(key: string): Promise<boolean | TransferRefusal>;
  /** A GET of one completed object signed for `lifeSeconds`: playback or delivery. */
  signRead(key: string, lifeSeconds: number): Promise<SignedTransfer | TransferRefusal>;
  /**
   * At most `length` bytes of a completed object from `from`, through a GET signed for that
   * object; in production custody carries it to the bucket's listed destination under its
   * timeout and response limit. The answer is the store's word, checked by the caller.
   */
  readRange(key: string, from: number, length: number): Promise<Uint8Array | TransferRefusal>;
}

export interface StorageProvider extends ObjectTransfers {
  put(tx: TenantQuery, body: Uint8Array): Promise<StoredObject | StoreRefusal>;
  get(
    tx: TenantQuery,
    id: string,
  ): Promise<(StoredObject & { readonly body: Uint8Array }) | undefined>;
  delete(tx: TenantQuery, id: string): Promise<boolean>;
}

export const storedDigestOf = (body: Uint8Array): string =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

const unsupported = (): Promise<TransferRefusal> =>
  Promise.resolve({ refused: 'TRANSFERS_UNSUPPORTED' });

/** The bounded database provider: one row per object, scoped by the row's business. */
export const DATABASE_STORAGE: StorageProvider = {
  partBytes: MOST_STORED_BYTES,
  open: unsupported,
  signPart: unsupported,
  listParts: unsupported,
  complete: unsupported,
  abort: unsupported,
  remove: unsupported,
  signRead: unsupported,
  readRange: unsupported,
  async put(tx, body) {
    if (body.byteLength === 0) return { refused: 'OBJECT_EMPTY' };
    if (body.byteLength > MOST_STORED_BYTES) return { refused: 'OBJECT_TOO_LARGE' };
    const stored = { id: randomUUID(), digest: storedDigestOf(body), byteCount: body.byteLength };
    await tx.query(
      `insert into public.storage_objects (business_id, id, digest, byte_count, body)
       values ($1, $2, $3, $4, $5)`,
      [tx.businessId, stored.id, stored.digest, stored.byteCount, Buffer.from(body)],
    );
    return stored;
  },
  async get(tx, id) {
    const [row] = await tx.query<{
      readonly digest: string;
      readonly byte_count: number;
      readonly body: Buffer;
    }>(
      `select digest, byte_count, body from public.storage_objects
        where business_id = $1 and id = $2`,
      [tx.businessId, id],
    );
    return row === undefined
      ? undefined
      : { id, digest: row.digest, byteCount: row.byte_count, body: new Uint8Array(row.body) };
  },
  async delete(tx, id) {
    const rows = await tx.query<{ readonly id: string }>(
      'delete from public.storage_objects where business_id = $1 and id = $2 returning id',
      [tx.businessId, id],
    );
    return rows.length > 0;
  },
};
