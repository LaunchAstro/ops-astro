// SPDX-License-Identifier: AGPL-3.0-only
//
// U89's media store records (#2038) on C35's world: each call made as a
// member in a business's transaction, judged at the review's holder by that
// member's `review:write`, against the store stand-in.

import { createHash } from 'node:crypto';
import {
  abandonMediaUpload,
  completeMediaUpload,
  mediaUploadParts,
  startMediaUpload,
  type Covering,
  type DeclaredAsset,
  type SignedPart,
} from '../../packages/core-records/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import type { C35World } from './c35-world.ts';
import type { MediaStoreDouble } from './media-store-double.ts';

export const digestOf = (body: Uint8Array): string =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

/** A review render: H.264 in an MP4, declared as exactly these bytes. */
export const renderOf = (body: Uint8Array, over: Partial<DeclaredAsset> = {}): DeclaredAsset => ({
  kind: 'video',
  type: 'video/mp4',
  codec: 'avc1.640028',
  byteCount: body.byteLength,
  digest: digestOf(body),
  ...over,
});

const coveringOf = (member: Member): Covering => ({
  subjects: [
    { kind: 'person', id: member.personId },
    { kind: 'actor', id: member.actorId },
  ],
  collection: 'review',
  action: 'write',
});

const writerOf = (member: Member) => ({
  actorId: member.actorId,
  personId: member.personId,
  delegationId: null,
});

export interface MediaCalls {
  start(
    member: Member,
    taskId: string,
    declared: DeclaredAsset,
    business?: string,
  ): ReturnType<typeof startMediaUpload>;
  parts(
    member: Member,
    assetId: string,
    want: number,
    business?: string,
  ): ReturnType<typeof mediaUploadParts>;
  complete(
    member: Member,
    assetId: string,
    business?: string,
  ): ReturnType<typeof completeMediaUpload>;
  abandon(
    member: Member,
    assetId: string,
    business?: string,
  ): ReturnType<typeof abandonMediaUpload>;
  /** Each signed part's slice of `body`, sent to its URL; the store's answers. */
  send(signed: readonly SignedPart[], body: Uint8Array): readonly number[];
  /** A column of the media rows of `business`, as the administrator reads it. */
  rows(
    table: 'reviews' | 'review_revisions' | 'review_media_assets',
    business: string,
  ): Promise<readonly Record<string, unknown>[]>;
}

export function mediaCalls(w: C35World, store: MediaStoreDouble): MediaCalls {
  const alpha = w.world.business;
  return {
    start: async (member, taskId, declared, business = alpha) =>
      await w.world.db.app.withBusiness(
        business,
        async (tx) =>
          await startMediaUpload(tx, { taskId, declared, writer: writerOf(member) }, store),
      ),
    parts: async (member, assetId, want, business = alpha) =>
      await w.world.db.app.withBusiness(
        business,
        async (tx) =>
          await mediaUploadParts(tx, { assetId, covering: coveringOf(member), want }, store),
      ),
    complete: async (member, assetId, business = alpha) =>
      await w.world.db.app.withBusiness(
        business,
        async (tx) =>
          await completeMediaUpload(
            tx,
            { assetId, covering: coveringOf(member), writer: writerOf(member) },
            store,
          ),
      ),
    abandon: async (member, assetId, business = alpha) =>
      await w.world.db.app.withBusiness(
        business,
        async (tx) =>
          await abandonMediaUpload(tx, { assetId, covering: coveringOf(member) }, store),
      ),
    send: (signed, body) =>
      signed.map((part) => {
        const from = (part.partNumber - 1) * store.partBytes;
        return store.send('PUT', part.url, body.subarray(from, from + store.partBytes)).status;
      }),
    rows: async (table, business) =>
      await w.world.db.admin.execute<Record<string, unknown>>(
        table === 'reviews'
          ? `select id, kind from public.reviews where business_id = $1 and kind = 'media'`
          : table === 'review_revisions'
            ? `select v.id, v.number, v.digest from public.review_revisions v
                 join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
                where v.business_id = $1 and c.kind = 'media' order by v.number`
            : `select id, state, revision_id from public.review_media_assets where business_id = $1`,
        [business],
      ),
  };
}
