// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2038): an upload on party A's task is reached by no caller whose
// grant does not cover party A. Another business's member, and a member whose
// review grant is on party B only, asking for parts, completing or abandoning
// it are each told it is not there; the store is asked nothing, the upload
// stays open and no revision is written. A start from another business on
// this business's task finds no task. Party B's own member uploads on party
// B's task.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { mediaCalls, renderOf, type MediaCalls } from './media-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 crossing: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73cross');
  store = mediaStoreDouble();
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const BODY = new Uint8Array([1, 2, 3, 4, 5, 6]);
const NOT_THERE = { code: 'NOT_FOUND' };

describe.skipIf(serverUrl === undefined)('C73 crossings', () => {
  it('C73 a cross-business or cross-client link is refused and stores nothing', async () => {
    const started = await media.start(w.ava, w.taskA, renderOf(BODY));
    if ('code' in started) throw new Error(`start refused ${started.code}`);
    const asked = store.calls.length;

    const crossings = {
      otherBusinessParts: await media.parts(w.eve, started.assetId, 4, w.beta),
      otherBusinessComplete: await media.complete(w.eve, started.assetId, w.beta),
      otherBusinessAbandon: await media.abandon(w.eve, started.assetId, w.beta),
      otherClientParts: await media.parts(w.dee, started.assetId, 4),
      otherClientComplete: await media.complete(w.dee, started.assetId),
      otherClientAbandon: await media.abandon(w.dee, started.assetId),
      otherBusinessStart: await media.start(w.eve, w.taskA, renderOf(BODY), w.beta),
    };
    expect(crossings).toStrictEqual({
      otherBusinessParts: NOT_THERE,
      otherBusinessComplete: NOT_THERE,
      otherBusinessAbandon: NOT_THERE,
      otherClientParts: NOT_THERE,
      otherClientComplete: NOT_THERE,
      otherClientAbandon: NOT_THERE,
      otherBusinessStart: NOT_THERE,
    });
    expect(store.calls.slice(asked)).toStrictEqual([]);
    expect(await media.rows('review_media_assets', w.world.business)).toMatchObject([
      { id: started.assetId, state: 'started', revision_id: null },
    ]);
    expect(await media.rows('review_media_assets', w.beta)).toStrictEqual([]);
    expect(await media.rows('reviews', w.beta)).toStrictEqual([]);

    const own = await media.start(w.dee, w.taskB, renderOf(BODY));
    if ('code' in own) throw new Error(`party B's start refused ${own.code}`);
    expect(await media.parts(w.dee, own.assetId, 4)).toMatchObject({ held: [] });
    expect(await media.abandon(w.dee, own.assetId)).toMatchObject({ reviewId: own.reviewId });
  });
});
