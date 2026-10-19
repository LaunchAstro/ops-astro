// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2038): a video declared as anything but H.264 or HEVC in an MP4 is a
// camera original, refused before the store is asked anything: no upload is
// opened, no part signed, and no review or asset row written. A review render
// starts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { mediaCalls, renderOf, type MediaCalls } from './media-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 codec: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73codec');
  store = mediaStoreDouble();
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const BODY = new Uint8Array(10).fill(7);

describe.skipIf(serverUrl === undefined)('C73 camera originals', () => {
  it('C73 a camera original is refused at the server before any part is signed', async () => {
    const originals = [
      renderOf(BODY, { type: 'video/quicktime', codec: 'apcn' }),
      renderOf(BODY, { type: 'video/mp4', codec: 'av01.0.08M.08' }),
      renderOf(BODY, { type: 'video/quicktime', codec: 'avc1.640028' }),
      renderOf(BODY, { codec: null }),
    ];
    const answers = await Promise.all(
      originals.map(async (declared) => await media.start(w.ava, w.taskA, declared)),
    );
    expect(answers).toStrictEqual(originals.map(() => ({ code: 'CAMERA_ORIGINAL' })));
    expect(store.calls).toStrictEqual([]);
    expect(await media.rows('reviews', w.world.business)).toStrictEqual([]);
    expect(await media.rows('review_media_assets', w.world.business)).toStrictEqual([]);

    const render = await media.start(w.ava, w.taskA, renderOf(BODY, { codec: 'hvc1.1.6.L93.B0' }));
    expect(render).toMatchObject({ partCount: 3 });
    expect(store.calls).toStrictEqual(['open']);
  });
});
