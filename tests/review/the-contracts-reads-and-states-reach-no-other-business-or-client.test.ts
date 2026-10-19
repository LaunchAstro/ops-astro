// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73 isolation): the contract's reads and states stay in their
// business and client. On party A's passed asset, another business's member
// and a member whose review grant is on party B only are each told the asset
// is not there when they ask to sign it, and the review read answers them
// nothing; the store is asked to sign nothing. Another business's
// transaction finds no quarantined object to scan and lands no verdict on
// party A's quarantined asset, which stays quarantined with its object kept.
// Party B's own member signs party B's own passed asset.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { digestOf, mediaCalls, type MediaCalls } from './media-world.ts';
import { PNG_BYTES, testScanEngine } from './media-fixtures.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 contract crossings: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73contractcross');
  store = mediaStoreDouble(16);
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const PNG = {
  kind: 'image' as const,
  type: 'image/png',
  codec: null,
  byteCount: PNG_BYTES.byteLength,
  digest: digestOf(PNG_BYTES),
};
const NOT_THERE = { code: 'NOT_FOUND' };

describe.skipIf(serverUrl === undefined)('C73 contract crossings', () => {
  it('C73 isolation: no sign, read or scan crosses a business or a client', async () => {
    const passed = await media.upload(w.ava, w.taskA, PNG, PNG_BYTES);
    const held = await media.upload(w.ava, w.taskA, PNG, PNG_BYTES);
    if (!('reviewId' in passed.completed)) throw new Error('party A uploads completed');
    expect(await media.scan(passed.assetId, testScanEngine)).toMatchObject({ verdict: 'passed' });
    const asked = store.calls.length;

    expect({
      otherBusinessSign: await media.sign(w.eve, passed.assetId, w.beta),
      otherClientSign: await media.sign(w.dee, passed.assetId),
      otherBusinessRead: await media.read(w.eve, passed.completed.reviewId, w.beta),
      otherClientRead: await media.read(w.dee, passed.completed.reviewId),
      otherBusinessScan: await media.scan(held.assetId, testScanEngine, w.beta),
    }).toStrictEqual({
      otherBusinessSign: NOT_THERE,
      otherClientSign: NOT_THERE,
      otherBusinessRead: undefined,
      otherClientRead: undefined,
      otherBusinessScan: NOT_THERE,
    });
    expect(store.calls.slice(asked)).toStrictEqual([]);
    expect(store.objects.size).toBe(2);
    expect(await media.rows('review_media_assets', w.world.business)).toMatchObject([
      { id: passed.assetId, scan_state: 'passed' },
      { id: held.assetId, scan_state: 'quarantined', scan_engine: null },
    ]);
    expect(await media.rows('review_media_assets', w.beta)).toStrictEqual([]);

    const own = await media.upload(w.dee, w.taskB, PNG, PNG_BYTES);
    expect(await media.scan(own.assetId, testScanEngine)).toMatchObject({ verdict: 'passed' });
    expect(await media.sign(w.dee, own.assetId)).toMatchObject({ method: 'GET' });
  });
});
