// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): a capture claimed and landed at both widths reads back as it landed. Each
// width's picture comes back from `review.picture` byte for byte with its digest, and
// `review.read` shows both widths landed with their own picture and observation. A picture
// over the storage cap is refused PICTURE_TOO_LARGE before anything is stored, and leaves
// its capture claimed for a land that fits.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  c35World,
  pickUpReviewed,
  underReview,
  type C35World,
  type Lease,
  type Reviewed,
} from './c35-world.ts';
import {
  capturesOf,
  claimUnder,
  landUnder,
  observationOf,
  pictureBytes,
  readPicture,
  storedObjects,
} from './c35-landing.ts';

/** The picture cap the spec sets (512 KiB), and a stored digest, both stated here, not read from the product. */
const MOST_STORED_BYTES = 512 * 1024;
const storedDigestOf = (body: Uint8Array): string =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 landed capture read back: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35landread');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A width's picture as it landed, with the id the land answered. */
interface Landed {
  readonly width: number;
  readonly picture: Buffer;
  readonly pictureId: string;
}

/** Land 1480 then 390 under `lease`, each answered with its own picture's id and digest. */
async function landBoth(reviewed: Reviewed, lease: Lease): Promise<Landed[]> {
  const wide = pictureBytes(14, 3_000);
  const narrow = pictureBytes(39, 1_200);
  const landed: Landed[] = [];
  for (const [width, picture] of [
    [1480, wide],
    [390, narrow],
  ] as const) {
    // Each land is its own call under the lease, one after the other.
    // eslint-disable-next-line no-await-in-loop
    const { result } = await landUnder(w, lease, {
      revisionId: reviewed.revisionId,
      width,
      picture,
    });
    expect(codeOf(result)).toBe('not-a-refusal');
    const detail = detailOf(result);
    expect(detail).toStrictEqual({
      revisionId: reviewed.revisionId,
      width,
      pictureId: detail['pictureId'],
      pictureDigest: storedDigestOf(picture),
    });
    landed.push({ width, picture, pictureId: String(detail['pictureId']) });
  }
  return landed;
}

/** Each picture's exact bytes, by its id. */
async function expectPicturesReadBack(landed: readonly Landed[]): Promise<void> {
  for (const { picture, pictureId } of landed) {
    // eslint-disable-next-line no-await-in-loop
    const read = await readPicture(w, w.ava, pictureId);
    if (isCommandRefusal(read) || !('picture' in read)) {
      throw new Error(`review.picture answered ${JSON.stringify(read)}`);
    }
    expect(read.picture).toStrictEqual({
      pictureId,
      digest: storedDigestOf(picture),
      byteCount: picture.byteLength,
      body: picture.toString('base64'),
    });
    expect(Buffer.from(read.picture.body, 'base64').equals(picture)).toBe(true);
  }
}

describe.skipIf(serverUrl === undefined)('C35 a landed capture reads back', () => {
  it('C35 a landed capture reads back at both widths, and an oversized picture stores nothing', async () => {
    const reviewed = await underReview(w, 'a capture read back');
    const lease = await pickUpReviewed(w, reviewed);
    expect(detailOf(await claimUnder(w, lease, reviewed.revisionId))).toStrictEqual({
      revisionId: reviewed.revisionId,
      widths: [390, 1480],
    });

    // One byte past the cap: refused, nothing stored, the capture still claimed.
    const stored = await storedObjects(w, w.world.business);
    const claimed = await capturesOf(w, reviewed.revisionId);
    const oversized = await landUnder(w, lease, {
      revisionId: reviewed.revisionId,
      width: 1480,
      picture: pictureBytes(9, MOST_STORED_BYTES + 1),
    });
    expect(codeOf(oversized.result)).toBe('PICTURE_TOO_LARGE');
    expect(await storedObjects(w, w.world.business)).toBe(stored);
    expect(await capturesOf(w, reviewed.revisionId)).toStrictEqual(claimed);

    const landed = await landBoth(reviewed, lease);
    expect(landed[0]?.pictureId).not.toBe(landed[1]?.pictureId);
    expect(await storedObjects(w, w.world.business)).toBe(stored + 2);

    // Each picture's exact bytes, by its id.
    await expectPicturesReadBack(landed);

    // The review shows both widths landed, each with its own picture and observation.
    const read = await w.read(w.ava, reviewed.reviewId);
    if (isCommandRefusal(read) || !('review' in read)) {
      throw new Error(`review.read answered ${JSON.stringify(read)}`);
    }
    const revision = read.review.revisions.find((one) => one.revisionId === reviewed.revisionId);
    expect(revision?.captures).toStrictEqual(
      landed.map(({ width, picture, pictureId }) => ({
        width,
        state: 'landed',
        pictureId,
        pictureDigest: storedDigestOf(picture),
        observation: observationOf(width),
      })),
    );
  }, 60_000);
});
