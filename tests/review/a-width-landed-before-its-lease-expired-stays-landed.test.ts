// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): a width landed while its lease was live stays landed when that lease runs
// out. A short lease claims both widths and lands 1480, then expires. The same work picked
// up again claims only what is left, 390, and lands it; 1480 keeps the picture, digest and
// lease it landed under, and the old lease can no longer land anything.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import {
  c35World,
  capturesOf,
  claimUnder,
  landUnder,
  pickUpAgainAfterExpiry,
  pickUpReviewed,
  pictureBytes,
  storedObjects,
  underReview,
  type C35World,
} from './c35-world.ts';

/** A stored picture's digest, computed here rather than by the product under test. */
const storedDigestOf = (body: Uint8Array): string =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C35 landed width outlives its lease: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35landkept');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 a landed width outlives its lease', () => {
  it('C35 a width landed before its lease expired stays landed and a later lease claims only the rest', async () => {
    const reviewed = await underReview(w, 'a capture landed in two leases');
    const stored = await storedObjects(w, w.world.business);
    const first = await pickUpReviewed(w, reviewed, 4);
    expect(detailOf(await claimUnder(w, first, reviewed.revisionId))).toStrictEqual({
      revisionId: reviewed.revisionId,
      widths: [390, 1480],
    });
    const wide = pictureBytes(148);
    const landedWide = await landUnder(w, first, {
      revisionId: reviewed.revisionId,
      width: 1480,
      picture: wide,
    });
    expect(codeOf(landedWide.result)).toBe('not-a-refusal');
    const widePicture = String(detailOf(landedWide.result)['pictureId']);

    const later = await pickUpAgainAfterExpiry(w, first);
    expect(later.leaseId).not.toBe(first.leaseId);
    expect(later.fence).toBeGreaterThan(first.fence);

    // Only the width not yet landed is claimed.
    expect(detailOf(await claimUnder(w, later, reviewed.revisionId))).toStrictEqual({
      revisionId: reviewed.revisionId,
      widths: [390],
    });
    // The landed width is not the later lease's to land again.
    const again = await landUnder(w, later, {
      revisionId: reviewed.revisionId,
      width: 1480,
      picture: pictureBytes(149),
    });
    expect(codeOf(again.result)).toBe('CAPTURE_NOT_CLAIMED');
    // The old lease lands nothing now.
    const late = await landUnder(w, first, {
      revisionId: reviewed.revisionId,
      width: 390,
      picture: pictureBytes(150),
    });
    expect(codeOf(late.result)).toBe('DELEGATION_NOT_LIVE');

    const narrow = pictureBytes(39);
    const landedNarrow = await landUnder(w, later, {
      revisionId: reviewed.revisionId,
      width: 390,
      picture: narrow,
    });
    expect(codeOf(landedNarrow.result)).toBe('not-a-refusal');
    const narrowPicture = String(detailOf(landedNarrow.result)['pictureId']);
    // Both landed: nothing is left to claim.
    expect(codeOf(await claimUnder(w, later, reviewed.revisionId))).toBe('CAPTURE_NOT_CLAIMABLE');

    expect(await capturesOf(w, reviewed.revisionId)).toStrictEqual([
      {
        width: 1480,
        state: 'landed',
        lease_id: first.leaseId,
        picture_id: widePicture,
        picture_digest: storedDigestOf(wide),
      },
      {
        width: 390,
        state: 'landed',
        lease_id: later.leaseId,
        picture_id: narrowPicture,
        picture_digest: storedDigestOf(narrow),
      },
    ]);
    expect(await storedObjects(w, w.world.business)).toBe(stored + 2);
  }, 60_000);
});
