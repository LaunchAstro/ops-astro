// SPDX-License-Identifier: AGPL-3.0-only
//
// The storage seam (C35, #2011): bytes kept by id, never by path, in the
// business whose transaction asks. One provider today, the bounded database
// one over `storage_objects`, so a picture lands in the same transaction as
// the capture row that names it. The media unit (U89, #2038) adds an object
// store behind the same seam and its multipart and signed-read methods.

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

export interface StorageProvider {
  put(tx: TenantQuery, body: Uint8Array): Promise<StoredObject | StoreRefusal>;
  get(
    tx: TenantQuery,
    id: string,
  ): Promise<(StoredObject & { readonly body: Uint8Array }) | undefined>;
  delete(tx: TenantQuery, id: string): Promise<boolean>;
}

export const storedDigestOf = (body: Uint8Array): string =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

/** The bounded database provider: one row per object, scoped by the row's business. */
export const DATABASE_STORAGE: StorageProvider = {
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
