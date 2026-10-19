// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73): the contract reads a completed object back only through
// the store's range read, a GET signed for that one object: every range is of
// the asset's own key, none asks past the per-read limit, and a render whose
// moov sits after a large mdat is probed without fetching the whole object.
// A store that answers a range with a byte more, or a byte fewer, than asked
// refuses the completion: the object is removed, the upload is abandoned and
// no revision is written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { mediaCalls, renderOf, type MediaCalls } from './media-world.ts';
import { mp4Of, type Mp4Shape } from './media-fixtures.ts';
import { MOST_RANGE_BYTES } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 range read: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73range');
  store = mediaStoreDouble(1024 * 1024);
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const LARGE: Mp4Shape = {
  codec: 'avc1',
  timescale: 12_800,
  delta: 512,
  frames: 25,
  timecode: { nominal: 25, dropFrame: false, start: 0 },
  moovAtEnd: true,
  padding: 3 * 1024 * 1024,
};

describe.skipIf(serverUrl === undefined)('C73 the range read', () => {
  it('C73 the range read is bounded to its own object; a hostile answer refuses the completion', async () => {
    const render = mp4Of(LARGE);
    const read = await media.upload(w.ava, w.taskA, renderOf(render), render);
    expect(read.completed).toMatchObject({
      number: 1,
      admission: { verdict: 'quarantined', probe: { startTimecode: '00:00:00:00' } },
    });
    const [key] = store.objects.keys();
    expect(store.ranges.length).toBeGreaterThan(0);
    expect(store.ranges.every((range) => range.key === key)).toBe(true);
    expect(Math.max(...store.ranges.map((range) => range.length))).toBeLessThanOrEqual(
      MOST_RANGE_BYTES,
    );
    const fetched = store.ranges.reduce((sum, range) => sum + range.length, 0);
    expect(fetched).toBeLessThan(render.byteLength / 4);

    const small = mp4Of({ ...LARGE, moovAtEnd: false, padding: 64 });
    store.answer = 'longer';
    const longer = await media.upload(w.ava, w.taskA, renderOf(small), small);
    store.answer = 'shorter';
    const shorter = await media.upload(w.ava, w.taskA, renderOf(small), small);
    store.answer = 'honest';
    expect([longer.completed, shorter.completed]).toStrictEqual([
      { code: 'STORE_ANSWER_REFUSED' },
      { code: 'STORE_ANSWER_REFUSED' },
    ]);
    expect(store.objects.size).toBe(1);
    expect(
      (await media.rows('review_media_assets', w.world.business)).map((row) => row['state']),
    ).toStrictEqual(['completed', 'abandoned', 'abandoned']);
    expect(await media.rows('review_revisions', w.world.business)).toHaveLength(1);
  });
});
