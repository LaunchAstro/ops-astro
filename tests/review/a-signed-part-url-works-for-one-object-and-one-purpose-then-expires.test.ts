// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2038): a part URL the store signs works for its one object, its one
// part and its one method, and only until its life ends; the store stand-in
// checks each as R2 does. The URL names the access key id and never the
// secret, and nothing the port answers carries it.

import { describe, expect, it } from 'vitest';
import { PART_LIFE_SECONDS } from '../../packages/core-records/src/index.ts';
import { DOUBLE_SECRET, mediaStoreDouble } from './media-store-double.ts';

const KEY_A = 'b0000000-0000-4000-8000-00000000000a/r/v/a';
const KEY_B = 'b0000000-0000-4000-8000-00000000000b/r/v/b';
const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('C73 signed part URLs', () => {
  it('C73 a signed part URL works for one object and one purpose, then expires', async () => {
    const store = mediaStoreDouble();
    const a = await store.open(KEY_A);
    const b = await store.open(KEY_B);
    if ('refused' in a || 'refused' in b) throw new Error('the stand-in opened no upload');
    const signed = await store.signPart(KEY_A, a.uploadId, 1, PART_LIFE_SECONDS);
    if ('refused' in signed) throw new Error('the stand-in signed no part');

    const otherObject = signed.url.replace(KEY_A, KEY_B).replace(a.uploadId, b.uploadId);
    const otherPart = signed.url.replace('partNumber=1', 'partNumber=2');
    expect({
      otherObject: store.send('PUT', otherObject, BYTES).status,
      otherPart: store.send('PUT', otherPart, BYTES).status,
      otherMethod: store.send('GET', signed.url, BYTES).status,
      itsOwn: store.send('PUT', signed.url, BYTES).status,
    }).toStrictEqual({ otherObject: 403, otherPart: 403, otherMethod: 403, itsOwn: 200 });

    store.clock.now = new Date(store.clock.now.getTime() + (PART_LIFE_SECONDS + 1) * 1000);
    expect(store.send('PUT', signed.url, BYTES)).toStrictEqual({ status: 403, why: 'expired' });
    expect(await store.listParts(KEY_A, a.uploadId)).toStrictEqual([
      { partNumber: 1, byteCount: 4 },
    ]);
    expect(await store.listParts(KEY_B, b.uploadId)).toStrictEqual([]);
  });

  it('C73 the broker holds the secret: a signed URL names the key id and never the secret', async () => {
    const store = mediaStoreDouble();
    const opened = await store.open(KEY_A);
    if ('refused' in opened) throw new Error('the stand-in opened no upload');
    const signed = await store.signPart(KEY_A, opened.uploadId, 1, PART_LIFE_SECONDS);
    const answers = JSON.stringify([opened, signed, await store.listParts(KEY_A, opened.uploadId)]);
    expect(answers).not.toContain(DOUBLE_SECRET);
    expect(answers).not.toContain(encodeURIComponent(DOUBLE_SECRET));
    if ('refused' in signed) throw new Error('the stand-in signed no part');
    expect(new URL(signed.url).searchParams.get('X-Amz-Credential')).toMatch(
      /^media-double-key-id\/\d{8}\/auto\/s3\/aws4_request$/u,
    );
  });
});
