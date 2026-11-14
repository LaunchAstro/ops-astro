// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2038): a caller that sent some parts and lost its connection asks
// again and is told the parts the store holds, and signed URLs for only the
// rest. Completion before the last part is refused and keeps the upload open;
// once the rest is sent, it completes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { digestOf, mediaCalls, renderOf, type MediaCalls } from './media-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 resume: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73resume');
  store = mediaStoreDouble();
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

describe.skipIf(serverUrl === undefined)('C73 resumable parts', () => {
  it('C73 finished parts are not sent again after a disconnect', async () => {
    const started = await media.start(w.ava, w.taskA, renderOf(BODY));
    if ('code' in started) throw new Error(`start refused ${started.code}`);
    expect(started.partCount).toBe(3);
    const first = await media.parts(w.ava, started.assetId, 2);
    if ('code' in first) throw new Error(`parts refused ${first.code}`);
    expect(first.signed.map((part) => part.partNumber)).toStrictEqual([1, 2]);
    expect(media.send(first.signed, BODY)).toStrictEqual([200, 200]);

    expect(await media.complete(w.ava, started.assetId)).toStrictEqual({
      code: 'UPLOAD_INCOMPLETE',
    });
    const back = await media.parts(w.ava, started.assetId, 4);
    if ('code' in back) throw new Error(`parts refused ${back.code}`);
    expect(back.held).toStrictEqual([
      { partNumber: 1, byteCount: 4 },
      { partNumber: 2, byteCount: 4 },
    ]);
    expect(back.signed.map((part) => part.partNumber)).toStrictEqual([3]);
    expect(media.send(back.signed, BODY)).toStrictEqual([200]);

    expect(await media.complete(w.ava, started.assetId)).toMatchObject({
      number: 1,
      digest: digestOf(BODY),
    });
  });
});
