// SPDX-License-Identifier: AGPL-3.0-only
//
// U89's media store records (#2038) on C35's world: each call made as a
// member in a business's transaction, judged at the review's holder by that
// member's `review:write`, against the store stand-in. The upload contract's
// calls (#2039): a signed read as a member, and a scan landed as the system
// in the business's transaction.

import { createHash } from 'node:crypto';
import {
  abandonMediaUpload,
  completeMediaUpload,
  landMediaScan,
  mediaUploadParts,
  objectChunks,
  quarantinedObject,
  readCoveredReview,
  signMediaRead,
  startMediaUpload,
  type Covering,
  type DeclaredAsset,
  type MediaScanner,
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

const coveringOf = (member: Member, action: 'read' | 'write' = 'write'): Covering => ({
  subjects: [
    { kind: 'person', id: member.personId },
    { kind: 'actor', id: member.actorId },
  ],
  collection: 'review',
  action,
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
  /** Start, send every part of `body` and complete; a refused start or parts ask throws. */
  upload(
    member: Member,
    taskId: string,
    declared: DeclaredAsset,
    body: Uint8Array,
    business?: string,
  ): Promise<{ readonly assetId: string; readonly completed: CompleteAnswer }>;
  /** A read signed for playback, as `member`. */
  sign(member: Member, assetId: string, business?: string): ReturnType<typeof signMediaRead>;
  /** The quarantined asset's object read through `scanner`, its verdict landed as the system. */
  scan(assetId: string, scanner: MediaScanner, business?: string): ReturnType<typeof landMediaScan>;
  /** The review as `member` reads it. */
  read(member: Member, reviewId: string, business?: string): ReturnType<typeof readCoveredReview>;
  /** Each signed part's slice of `body`, sent to its URL; the store's answers. */
  send(signed: readonly SignedPart[], body: Uint8Array): readonly number[];
  /** A column of the media rows of `business`, as the administrator reads it. */
  rows(
    table: 'reviews' | 'review_revisions' | 'review_media_assets',
    business: string,
  ): Promise<readonly Record<string, unknown>[]>;
}

type CompleteAnswer = Awaited<ReturnType<typeof completeMediaUpload>>;

type UploadCalls = Omit<MediaCalls, 'upload' | 'sign' | 'scan' | 'read'>;

export const mediaCalls = (w: C35World, store: MediaStoreDouble): MediaCalls => {
  const uploads = uploadCalls(w, store);
  return { ...uploads, ...contractCalls(w, store, uploads) };
};

function uploadCalls(w: C35World, store: MediaStoreDouble): UploadCalls {
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
    // A plain array: the driver's result carries its own fields, which a strict match counts.
    rows: async (table, business) => [
      ...(await w.world.db.admin.execute<Record<string, unknown>>(
        table === 'reviews'
          ? `select id, kind from public.reviews where business_id = $1 and kind = 'media'`
          : table === 'review_revisions'
            ? `select v.id, v.number, v.digest from public.review_revisions v
                 join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
                where v.business_id = $1 and c.kind = 'media' order by v.number`
            : `select id, state, revision_id, refusal, scan_state, scan_engine
                 from public.review_media_assets where business_id = $1 order by created_at`,
        [business],
      )),
    ],
  };
}

/** The upload contract's calls (#2039): a whole upload, a signed read, a scan, a review read. */
function contractCalls(
  w: C35World,
  store: MediaStoreDouble,
  calls: UploadCalls,
): Pick<MediaCalls, 'upload' | 'sign' | 'scan' | 'read'> {
  const alpha = w.world.business;
  return {
    upload: wholeUpload(calls, alpha),
    sign: async (member, assetId, business = alpha) =>
      await w.world.db.app.withBusiness(
        business,
        async (tx) =>
          await signMediaRead(
            tx,
            { assetId, covering: coveringOf(member, 'read'), lifeSeconds: 300 },
            store,
          ),
      ),
    scan: async (assetId, scanner, business = alpha) => {
      const object = await w.world.db.app.withBusiness(
        business,
        async (tx) => await quarantinedObject(tx, assetId),
      );
      const verdict =
        object === undefined
          ? 'failed'
          : await scanner.scan(objectChunks(store, object.key, object.byteCount));
      return await w.world.db.app.withBusiness(
        business,
        async (tx) => await landMediaScan(tx, { assetId, engine: scanner.engine, verdict }, store),
      );
    },
    read: async (member, reviewId, business = alpha) =>
      await w.world.db.app.withBusiness(
        business,
        async (tx) => await readCoveredReview(tx, reviewId, coveringOf(member, 'read')),
      ),
  };
}

/** Start, send every part the store does not hold yet, then complete. */
const wholeUpload =
  (calls: UploadCalls, alpha: string): MediaCalls['upload'] =>
  async (member, taskId, declared, body, business = alpha) => {
    const started = await calls.start(member, taskId, declared, business);
    if ('code' in started) throw new Error(`start refused ${started.code}`);
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the next ask depends on what was sent
      const parts = await calls.parts(member, started.assetId, 16, business);
      if ('code' in parts) throw new Error(`parts refused ${parts.code}`);
      if (parts.signed.length === 0) break;
      if (!calls.send(parts.signed, body).every((status) => status === 200))
        throw new Error('a part was refused by the store');
    }
    return {
      assetId: started.assetId,
      completed: await calls.complete(member, started.assetId, business),
    };
  };
