// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2038): completion compares the store's size and digest with the
// declared ones before any revision exists. A different digest, or a
// different size, removes the stored object, marks the upload abandoned and
// keeps no revision; a matching upload becomes revision one, digested as its
// asset.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { digestOf, mediaCalls, renderOf, type MediaCalls } from './media-world.ts';
import type { DeclaredAsset } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 mismatch: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73match');
  store = mediaStoreDouble();
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/** Start an upload of `declared`, send `body` in the parts it asks for, then complete. */
async function upload(declared: DeclaredAsset, body: Uint8Array) {
  const started = await media.start(w.ava, w.taskA, declared);
  if ('code' in started) throw new Error(`start refused ${started.code}`);
  const parts = await media.parts(w.ava, started.assetId, 4);
  if ('code' in parts) throw new Error(`parts refused ${parts.code}`);
  expect(media.send(parts.signed, body).every((status) => status === 200)).toBe(true);
  return { assetId: started.assetId, completed: await media.complete(w.ava, started.assetId) };
}

describe.skipIf(serverUrl === undefined)('C73 completion', () => {
  it('C73 a completed upload whose size or checksum differs leaves no revision', async () => {
    const otherDigest = await upload(
      renderOf(BODY, { digest: digestOf(new Uint8Array(10)) }),
      BODY,
    );
    const otherSize = await upload(renderOf(BODY, { byteCount: 9 }), BODY);
    expect([otherDigest.completed, otherSize.completed]).toStrictEqual([
      { code: 'UPLOAD_MISMATCH' },
      { code: 'UPLOAD_MISMATCH' },
    ]);
    expect(await media.rows('review_revisions', w.world.business)).toStrictEqual([]);
    expect(store.objects.size).toBe(0);
    expect(
      (await media.rows('review_media_assets', w.world.business)).map((row) => row['state']),
    ).toStrictEqual(['abandoned', 'abandoned']);

    const matching = await upload(renderOf(BODY), BODY);
    expect(matching.completed).toMatchObject({ number: 1, digest: digestOf(BODY) });
    expect(await media.rows('review_revisions', w.world.business)).toMatchObject([
      { number: 1, digest: digestOf(BODY) },
    ]);
    expect(store.objects.size).toBe(1);
    expect(await media.complete(w.ava, matching.assetId)).toStrictEqual({
      code: 'UPLOAD_NOT_OPEN',
    });
  });
});
