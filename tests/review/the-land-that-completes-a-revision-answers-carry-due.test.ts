// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2075, S2165-2): `review.capture_land` tells its worker when to carry. The land that
// completes a revision's last width answers `carryDue: true` while a pin before it is not yet
// carried onto it; every other land answers false: an earlier width, a first revision with no
// pin before it, and a revision whose pins are carried. Lands of one revision never interleave:
// the claim gives every width to one lease, and each land takes that lease's lock first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, pickUpReviewed, underReview, type C35World, type Lease } from './c35-world.ts';
import { claimUnder, pictureBytes, underLease } from './c35-landing.ts';
import { carryUnder, must, nextRevision, observed, pinOn } from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X carry due: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xdue');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const PAGE = { text: 'Book a visit today. Our team.', document: 'a' };

/** Land one width of `revisionId` under `lease`; its `carryDue`. */
async function landDue(lease: Lease, revisionId: string, width: number): Promise<unknown> {
  const { result } = await underLease(w, lease, {
    command: 'review.capture_land',
    revisionId,
    width,
    picture: pictureBytes(width).toString('base64'),
    observation: observed(width, PAGE),
  });
  return must(result, 'review.capture_land')['carryDue'];
}

/** A review whose first revision has landed and holds a pin, and its claimed next revision. */
async function pinnedThenNext(title: string): Promise<{ lease: Lease; next: string }> {
  const reviewed = await underReview(w, title);
  const lease = await pickUpReviewed(w, reviewed);
  must(await claimUnder(w, lease, reviewed.revisionId), 'review.capture_claim');
  expect([
    await landDue(lease, reviewed.revisionId, 1480),
    await landDue(lease, reviewed.revisionId, 390),
  ]).toEqual([false, false]);
  await pinOn(w, reviewed.revisionId);
  const next = await nextRevision(w, reviewed);
  must(await claimUnder(w, lease, next), 'review.capture_claim');
  return { lease, next };
}

describe.skipIf(serverUrl === undefined)('C35-X the land answers whether a carry is due', () => {
  it('only the land completing a revision with an uncarried pin before it answers carryDue', async () => {
    const { lease, next } = await pinnedThenNext('Carry due on the last land');
    expect(await landDue(lease, next, 1480)).toBe(false);
    expect(await landDue(lease, next, 390)).toBe(true);
    must((await carryUnder(w, lease, next)).result, 'review.carry_pins');
  }, 120_000);
});
