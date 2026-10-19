// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73): a clean asset lands quarantined. Until a scanner's
// verdict lands, a playback sign is refused by name and the store is asked to
// sign nothing; once the scan passes, the sign is a GET of that one object
// the store answers. A verdict lands once: a second land finds no
// quarantined asset. The review read says quarantined, then playable.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { digestOf, mediaCalls, type MediaCalls } from './media-world.ts';
import { PNG_BYTES, testScanEngine } from './media-fixtures.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 quarantine: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73quarantine');
  store = mediaStoreDouble(16);
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C73 quarantine', () => {
  it('C73 a quarantined asset never signs: refused by name before the scan passes, allowed after', async () => {
    const clean = await media.upload(
      w.ava,
      w.taskA,
      {
        kind: 'image',
        type: 'image/png',
        codec: null,
        byteCount: PNG_BYTES.byteLength,
        digest: digestOf(PNG_BYTES),
      },
      PNG_BYTES,
    );
    if (!('reviewId' in clean.completed)) throw new Error('the clean upload completed');
    expect(clean.completed.admission).toStrictEqual({ verdict: 'quarantined', probe: null });

    expect(await media.sign(w.ava, clean.assetId)).toStrictEqual({ code: 'ASSET_QUARANTINED' });
    expect(store.calls).not.toContain('signRead');
    expect((await media.read(w.ava, clean.completed.reviewId))?.revisions[0]?.media).toMatchObject({
      playable: false,
      why: 'quarantined',
    });

    expect(await media.scan(clean.assetId, testScanEngine)).toStrictEqual({
      assetId: clean.assetId,
      verdict: 'passed',
    });
    const signed = await media.sign(w.ava, clean.assetId);
    if (!('url' in signed)) throw new Error(`the passed asset's sign refused ${signed.code}`);
    expect(signed.method).toBe('GET');
    expect(store.send('GET', signed.url, new Uint8Array())).toStrictEqual({
      status: 200,
      body: PNG_BYTES,
    });
    expect((await media.read(w.ava, clean.completed.reviewId))?.revisions[0]?.media).toMatchObject({
      playable: true,
      why: null,
    });

    expect(await media.scan(clean.assetId, testScanEngine)).toStrictEqual({ code: 'NOT_FOUND' });
    expect(await media.rows('review_media_assets', w.world.business)).toMatchObject([
      { id: clean.assetId, scan_state: 'passed', scan_engine: testScanEngine.engine },
    ]);
  });
});
