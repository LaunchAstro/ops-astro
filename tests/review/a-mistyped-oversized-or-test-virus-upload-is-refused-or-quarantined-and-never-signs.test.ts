// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73 upload contract): every upload goes through one contract.
// A file declared as an MP4 whose bytes are a PDF is refused by its sniffed
// type and its object removed; a file past its kind's size limit, or of a
// type its kind does not take, is refused before the store is asked anything;
// a well-typed file holding the test-virus signature lands quarantined, and
// the test engine's scan fails it. None of them can be signed for playback,
// and the review read says why each version cannot play.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { digestOf, mediaCalls, renderOf, type MediaCalls } from './media-world.ts';
import { PDF_BYTES, PNG_BYTES, TEST_VIRUS, testScanEngine } from './media-fixtures.ts';
import { MOST_BYTES_BY_KIND } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 upload contract: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73contract');
  store = mediaStoreDouble(16);
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const imageOf = (body: Uint8Array) => ({
  kind: 'image' as const,
  type: 'image/png',
  codec: null,
  byteCount: body.byteLength,
  digest: digestOf(body),
});

const NEVER_PLAYS = { playable: false, probe: null };

describe.skipIf(serverUrl === undefined)('C73 upload contract', () => {
  it('C73 upload contract: a mistyped file is refused by its bytes, an oversized one before the store', async () => {
    const mistyped = await media.upload(w.ava, w.taskA, renderOf(PDF_BYTES), PDF_BYTES);
    if (!('reviewId' in mistyped.completed)) throw new Error('the mistyped upload completed');
    expect(mistyped.completed.admission).toStrictEqual({
      verdict: 'refused',
      refusal: 'TYPE_MISMATCH',
    });
    expect(store.objects.size).toBe(0);

    const asked = store.calls.length;
    const oversized = await media.start(w.ava, w.taskA, {
      ...imageOf(PNG_BYTES),
      byteCount: MOST_BYTES_BY_KIND.image + 1,
    });
    const unsupported = await media.start(w.ava, w.taskA, {
      ...imageOf(PNG_BYTES),
      type: 'image/svg+xml',
    });
    expect([oversized, unsupported]).toStrictEqual([
      { code: 'TOO_LARGE_FOR_CLASS' },
      { code: 'TYPE_UNSUPPORTED' },
    ]);
    expect(store.calls.slice(asked)).toStrictEqual([]);

    expect(await media.sign(w.ava, mistyped.assetId)).toStrictEqual({ code: 'ASSET_REFUSED' });
    expect(store.calls).not.toContain('signRead');
    const review = await media.read(w.ava, mistyped.completed.reviewId);
    expect(review?.revisions.map((revision) => revision.media)).toStrictEqual([
      { ...NEVER_PLAYS, assetId: mistyped.assetId, kind: 'video', why: 'TYPE_MISMATCH' },
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('C73 upload contract, quarantine', () => {
  it('C73 upload contract: the planted test-virus file lands quarantined, fails its scan and never signs', async () => {
    const body = new Uint8Array([...PNG_BYTES, ...TEST_VIRUS]);
    const infected = await media.upload(w.ava, w.taskB, imageOf(body), body);
    if (!('reviewId' in infected.completed)) throw new Error('the infected upload completed');
    expect(infected.completed.admission).toStrictEqual({ verdict: 'quarantined', probe: null });
    expect(await media.sign(w.ava, infected.assetId)).toStrictEqual({ code: 'ASSET_QUARANTINED' });

    expect(await media.scan(infected.assetId, testScanEngine)).toStrictEqual({
      assetId: infected.assetId,
      verdict: 'failed',
    });
    expect(store.objects.size).toBe(0);
    expect(await media.sign(w.ava, infected.assetId)).toStrictEqual({ code: 'ASSET_SCAN_FAILED' });
    expect(store.calls).not.toContain('signRead');
    expect(await media.rows('review_media_assets', w.world.business)).toMatchObject([
      { refusal: 'TYPE_MISMATCH', scan_state: null },
      {
        id: infected.assetId,
        refusal: null,
        scan_state: 'failed',
        scan_engine: testScanEngine.engine,
      },
    ]);
    const review = await media.read(w.ava, infected.completed.reviewId);
    expect(review?.revisions.map((revision) => revision.media)).toStrictEqual([
      { ...NEVER_PLAYS, assetId: infected.assetId, kind: 'image', why: 'scan_failed' },
    ]);
  });
});
