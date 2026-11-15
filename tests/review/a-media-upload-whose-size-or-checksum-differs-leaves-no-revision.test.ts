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
import { mp4Of } from './media-fixtures.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 mismatch: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73match');
  store = mediaStoreDouble(64);
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

// A real render, so the upload contract (#2039) admits the matching upload by its sniffed type.
const BODY = mp4Of({ codec: 'avc1', timescale: 25, delta: 1, frames: 10 });
const upload = async (declared: Parameters<MediaCalls['upload']>[2], body: Uint8Array) =>
  await media.upload(w.ava, w.taskA, declared, body);

describe.skipIf(serverUrl === undefined)('C73 completion', () => {
  it('C73 a completed upload whose size or checksum differs leaves no revision', async () => {
    const otherDigest = await upload(
      renderOf(BODY, { digest: digestOf(new Uint8Array(BODY.byteLength)) }),
      BODY,
    );
    const otherSize = await upload(renderOf(BODY, { byteCount: BODY.byteLength - 1 }), BODY);
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

describe.skipIf(serverUrl === undefined)('C73 a mismatch the store could not remove', () => {
  // S2126-1: a mismatched object the store could not remove is not left stored behind an
  // abandoned upload; the upload stays open, and abandoning it removes the object.
  it.each([
    ['false', () => Promise.resolve(false)],
    ['a refusal', () => Promise.resolve({ refused: 'STORE_UNAVAILABLE' as const })],
  ])(
    'C73 a mismatch the store could not remove stays open until abandon removes it (%s)',
    async (_, failing) => {
      const own = mediaStoreDouble();
      const calls = mediaCalls(w, own);
      const started = await calls.start(w.ava, w.taskA, renderOf(BODY, { byteCount: 9 }));
      if ('code' in started) throw new Error(`start refused ${started.code}`);
      const parts = await calls.parts(w.ava, started.assetId, 4);
      if ('code' in parts) throw new Error(`parts refused ${parts.code}`);
      calls.send(parts.signed, BODY);
      const remove = own.remove.bind(own);
      own.remove = failing as typeof own.remove;
      expect(await calls.complete(w.ava, started.assetId)).toStrictEqual({ code: 'STORE_REFUSED' });
      expect(own.objects.size).toBe(1);
      const state = async () =>
        (await calls.rows('review_media_assets', w.world.business)).find(
          (row) => row['id'] === started.assetId,
        )?.['state'];
      expect(await state()).toBe('started');

      own.remove = remove;
      expect(await calls.abandon(w.ava, started.assetId)).toMatchObject({
        reviewId: started.reviewId,
      });
      expect(own.objects.size).toBe(0);
      expect(await state()).toBe('abandoned');
      expect(
        (await calls.rows('review_revisions', w.world.business)).map((row) => row['number']),
      ).toStrictEqual([1]);
    },
  );
});

describe.skipIf(serverUrl === undefined)('C73 an abandon the store could not abort', () => {
  // S2126-1 follow-up: abandon falls back to removing the object only when the store no longer
  // knows the upload. A store that is unavailable keeps the upload open, even where its delete
  // answers success for a key it does not hold (as R2's delete does), so no parts are left behind.
  it('C73 an abandon the store could not abort stays open, its parts kept for the retry', async () => {
    const own = mediaStoreDouble();
    const calls = mediaCalls(w, own);
    const started = await calls.start(w.ava, w.taskA, renderOf(BODY));
    if ('code' in started) throw new Error(`start refused ${started.code}`);
    const parts = await calls.parts(w.ava, started.assetId, 4);
    if ('code' in parts) throw new Error(`parts refused ${parts.code}`);
    calls.send(parts.signed, BODY);
    const abort = own.abort.bind(own);
    const remove = own.remove.bind(own);
    own.abort = (() =>
      Promise.resolve({ refused: 'STORE_UNAVAILABLE' as const })) as unknown as typeof own.abort;
    own.remove = (() => Promise.resolve(true)) as typeof own.remove;
    expect(await calls.abandon(w.ava, started.assetId)).toStrictEqual({ code: 'STORE_REFUSED' });
    const state = async () =>
      (await calls.rows('review_media_assets', w.world.business)).find(
        (row) => row['id'] === started.assetId,
      )?.['state'];
    expect(await state()).toBe('started');

    own.abort = abort;
    own.remove = remove;
    expect(await calls.abandon(w.ava, started.assetId)).toMatchObject({
      reviewId: started.reviewId,
    });
    expect(own.calls.filter((call) => call === 'abort')).toHaveLength(1);
    expect(await state()).toBe('abandoned');
  });
});
