// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73): an MP4's probe is read from the file's own boxes. Renders
// at 25, 29.97 (drop-frame) and 23.976 read back their frame rate as an exact
// rational, their start timecode from the timecode track and their duration
// in the track's timescale, with moov before or after mdat; a render with no
// timecode track starts at zero. On completion the probe is recorded on the
// asset and the review read carries it; a probe that disagrees with the
// declared codec refuses the asset, and one that cannot be read refuses it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { mediaCalls, renderOf, type MediaCalls } from './media-world.ts';
import { mp4Of, PDF_BYTES, type Mp4Shape } from './media-fixtures.ts';
import { probeMp4 } from '../../packages/core-records/src/index.ts';

const FIXTURES: readonly (readonly [string, Mp4Shape, object])[] = [
  [
    '25',
    {
      codec: 'avc1',
      timescale: 12_800,
      delta: 512,
      frames: 50,
      timecode: { nominal: 25, dropFrame: false, start: 900_000 },
    },
    { fps: { num: 25, den: 1 }, startTimecode: '10:00:00:00', duration: 25_600, timescale: 12_800 },
  ],
  [
    '29.97 drop-frame, moov at the end',
    {
      codec: 'avc1',
      timescale: 30_000,
      delta: 1001,
      frames: 60,
      timecode: { nominal: 30, dropFrame: true, start: 1800 },
      moovAtEnd: true,
    },
    {
      fps: { num: 30_000, den: 1001 },
      startTimecode: '00:01:00;02',
      duration: 60_060,
      timescale: 30_000,
    },
  ],
  [
    '23.976',
    {
      codec: 'hvc1',
      timescale: 24_000,
      delta: 1001,
      frames: 48,
      timecode: { nominal: 24, dropFrame: false, start: 86_400 },
    },
    {
      codec: 'hvc1',
      fps: { num: 24_000, den: 1001 },
      startTimecode: '01:00:00:00',
      duration: 48_048,
      timescale: 24_000,
    },
  ],
  [
    '25 with no timecode track',
    { codec: 'avc1', timescale: 25, delta: 1, frames: 10 },
    { fps: { num: 25, den: 1 }, startTimecode: '00:00:00:00', duration: 10, timescale: 25 },
  ],
];

const readerOf =
  (bytes: Uint8Array) =>
  (from: number, length: number): Promise<Uint8Array> =>
    Promise.resolve(bytes.slice(from, from + length));

describe('C73 the MP4 probe', () => {
  it.each(FIXTURES)('C73 the probe reads a %s render exactly', async (_name, shape, expected) => {
    const bytes = mp4Of(shape);
    expect(await probeMp4(readerOf(bytes), bytes.byteLength)).toMatchObject({
      codec: shape.codec,
      ...expected,
    });
  });

  it('C73 a file with no moov, or a box past its parent, has no probe', async () => {
    const truncated = mp4Of(FIXTURES[0]![1]).slice(0, 200);
    expect(await probeMp4(readerOf(PDF_BYTES), PDF_BYTES.byteLength)).toBeUndefined();
    expect(await probeMp4(readerOf(truncated), truncated.byteLength)).toBeUndefined();
  });
});

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 probe records: DATABASE_URL is unset, so the database half did not run.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73probe');
  store = mediaStoreDouble(64);
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C73 the probe on completion', () => {
  it('C73 the probe records fps, start timecode and duration; a disagreeing codec refuses', async () => {
    const dropFrame = mp4Of(FIXTURES[1]![1]);
    const recorded = await media.upload(w.ava, w.taskA, renderOf(dropFrame), dropFrame);
    const probe = {
      codec: 'avc1',
      fps: { num: 30_000, den: 1001 },
      startTimecode: '00:01:00;02',
      duration: 60_060,
      timescale: 30_000,
    };
    expect(recorded.completed).toMatchObject({ admission: { verdict: 'quarantined', probe } });

    const disagreeing = await media.upload(
      w.ava,
      w.taskA,
      renderOf(dropFrame, { codec: 'hvc1.1.6.L93.B0' }),
      dropFrame,
    );
    const unreadable = new Uint8Array([...dropFrame.slice(0, 40), ...new Uint8Array(40)]);
    const noMoov = await media.upload(w.ava, w.taskA, renderOf(unreadable), unreadable);
    expect([disagreeing.completed, noMoov.completed]).toMatchObject([
      { admission: { verdict: 'refused', refusal: 'PROBE_DISAGREES' } },
      { admission: { verdict: 'refused', refusal: 'PROBE_UNREADABLE' } },
    ]);

    if (!('reviewId' in recorded.completed)) throw new Error('the render completed');
    const review = await media.read(w.ava, recorded.completed.reviewId);
    expect(review?.revisions.map((revision) => revision.media)).toMatchObject([
      { assetId: recorded.assetId, why: 'quarantined', probe },
      { assetId: disagreeing.assetId, why: 'PROBE_DISAGREES', probe: null },
      { assetId: noMoov.assetId, why: 'PROBE_UNREADABLE', probe: null },
    ]);
    expect(await media.sign(w.ava, disagreeing.assetId)).toStrictEqual({ code: 'ASSET_REFUSED' });
  });
});
