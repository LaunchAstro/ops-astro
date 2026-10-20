// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73): a clean asset lands quarantined. Until a scanner's
// verdict lands, a playback sign is refused by name and the store is asked to
// sign nothing; once the scan passes, the sign is a GET of that one object
// the store answers. A verdict lands once: a second land finds no
// quarantined asset. The review read says quarantined, then playable. A sign
// for no time, part of a second or more than an hour is refused by name, and
// a row that is not completed carries no admission.

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

const PNG_DECLARED = {
  kind: 'image',
  type: 'image/png',
  codec: null,
  byteCount: PNG_BYTES.byteLength,
  digest: digestOf(PNG_BYTES),
} as const;

describe.skipIf(serverUrl === undefined)('C73 quarantine', () => {
  it('C73 a quarantined asset never signs: refused by name before the scan passes, allowed after', async () => {
    const clean = await media.upload(w.ava, w.taskA, PNG_DECLARED, PNG_BYTES);
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

describe.skipIf(serverUrl === undefined)(
  'C73 a sign within its life, a row within its state',
  () => {
    it('C73 a sign for no time, part of a second or past an hour is refused by name', async () => {
      const clean = await media.upload(w.ava, w.taskA, PNG_DECLARED, PNG_BYTES);
      expect(await media.scan(clean.assetId, testScanEngine)).toMatchObject({ verdict: 'passed' });
      const signsBefore = store.calls.filter((call) => call === 'signRead').length;
      const lives = [0, 1.5, 3601, Number.POSITIVE_INFINITY];
      for (const life of lives)
        // oxlint-disable-next-line no-await-in-loop -- each sign is its own transaction
        expect(await media.sign(w.ava, clean.assetId, undefined, life)).toStrictEqual({
          code: 'LIFE_OUT_OF_RANGE',
        });
      expect(store.calls.filter((call) => call === 'signRead')).toHaveLength(signsBefore);
      expect(await media.sign(w.ava, clean.assetId, undefined, 3600)).toMatchObject({
        method: 'GET',
      });
    });

    it('C73 a media asset that is not completed carries no refusal or scan state', async () => {
      const started = await media.start(w.ava, w.taskA, PNG_DECLARED);
      if ('code' in started) throw new Error(`start refused ${started.code}`);
      const admit = async (state: 'started' | 'abandoned') =>
        await w.world.db.admin.execute(
          `update public.review_media_assets
            set state = $3, refusal = 'TYPE_MISMATCH', scan_state = 'quarantined'
          where business_id = $1 and id = $2`,
          [w.world.business, started.assetId, state],
        );
      await expect(admit('started')).rejects.toThrow(
        /review_media_assets_completed_is_admitted_once/u,
      );
      await expect(admit('abandoned')).rejects.toThrow(
        /review_media_assets_completed_is_admitted_once/u,
      );
      expect(
        (await media.rows('review_media_assets', w.world.business)).find(
          (row) => row['id'] === started.assetId,
        ),
      ).toMatchObject({ state: 'started', refusal: null, scan_state: null });
    });
  },
);
