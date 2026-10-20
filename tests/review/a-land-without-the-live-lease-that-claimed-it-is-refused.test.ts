// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): a capture lands only under the live lease, at its fence, that claimed it.
// A lease claims a revision's captures and then runs out. Its own expired credential is
// refused before anything is looked at (DELEGATION_NOT_LIVE), and the old lease presented
// with the later pickup's live credential is not that caller's (LEASE_NOT_OWNED). The later
// lease on the same task never claimed the rows (CAPTURE_NOT_CLAIMED). A live lease on
// another task of the same business, and any lease asking for another business's capture,
// find no such capture (NOT_FOUND). Each refusal stores no picture and moves no capture row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import {
  c35World,
  pickUpAgainAfterExpiry,
  pickUpReviewed,
  underReview,
  untilExpired,
  type C35World,
  type Lease,
  type Reviewed,
} from './c35-world.ts';
import { capturesOf, claimUnder, landUnder, pictureBytes, storedObjects } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C35 land without the claiming lease: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35landlease');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** Another task of alpha's, picked up for the default lease, and a capture asked in beta. */
async function elsewhere(): Promise<{ readonly otherLease: Lease; readonly betaRevision: string }> {
  const other = await underReview(w, 'another task under review');
  const otherLease = await pickUpReviewed(w, other);
  const opened = detailOf(await w.open(w.eve, { taskId: w.betaTask }, w.beta));
  expect(codeOf(await w.capture(w.eve, opened['revisionId'], w.beta))).toBe('not-a-refusal');
  return { otherLease, betaRevision: String(opened['revisionId']) };
}

/** A capture under review, its widths claimed by a lease of three seconds. */
async function claimedByShortLease(): Promise<{
  readonly reviewed: Reviewed;
  readonly claiming: Lease;
}> {
  const reviewed = await underReview(w, 'a capture its lease claimed');
  const claiming = await pickUpReviewed(w, reviewed, 3);
  expect(detailOf(await claimUnder(w, claiming, reviewed.revisionId))).toStrictEqual({
    revisionId: reviewed.revisionId,
    widths: [390, 1480],
  });
  return { reviewed, claiming };
}

/** The land of a 1480 picture under `lease`, answered as its code. */
const land = async (lease: Lease, revisionId: string, seed: number) =>
  codeOf(
    (await landUnder(w, lease, { revisionId, width: 1480, picture: pictureBytes(seed) })).result,
  );

describe.skipIf(serverUrl === undefined)('C35 a land needs the claiming lease', () => {
  it('C35 a land without the live lease that claimed it is refused and stores nothing', async () => {
    // Another task of alpha's, picked up for the default lease, and a capture asked in beta.
    const { otherLease, betaRevision } = await elsewhere();

    // The capture under test, claimed by a short lease.
    const { reviewed, claiming } = await claimedByShortLease();

    const claimed = await capturesOf(w, reviewed.revisionId);
    const betaCaptures = await capturesOf(w, betaRevision);
    expect(betaCaptures.map((row) => row.state)).toStrictEqual(['requested', 'requested']);
    const before = {
      alpha: await storedObjects(w, w.world.business),
      beta: await storedObjects(w, w.beta),
    };

    // A live lease of the same business, on another task: the capture is not its task's.
    expect(await land(otherLease, reviewed.revisionId, 1)).toBe('NOT_FOUND');
    // Another business's capture, by its revision id, under a live lease here.
    expect(await land(otherLease, betaRevision, 2)).toBe('NOT_FOUND');
    expect(codeOf(await claimUnder(w, otherLease, betaRevision))).toBe('NOT_FOUND');

    // The claiming lease, run out: its credential is no longer live.
    await untilExpired(w, claiming);
    expect(await land(claiming, reviewed.revisionId, 3)).toBe('DELEGATION_NOT_LIVE');
    expect(await land(claiming, betaRevision, 4)).toBe('DELEGATION_NOT_LIVE');

    // A later lease on the same task, which never claimed the rows.
    const later = await pickUpAgainAfterExpiry(w, claiming);
    expect(later.fence).toBeGreaterThan(claiming.fence);
    expect(await land(later, reviewed.revisionId, 5)).toBe('CAPTURE_NOT_CLAIMED');
    // The old lease and fence presented with the later pickup's live credential.
    const oldUnderNew: Lease = { ...claiming, credential: later.credential };
    expect(await land(oldUnderNew, reviewed.revisionId, 6)).toBe('LEASE_NOT_OWNED');
    expect(await land(claiming, reviewed.revisionId, 7)).toBe('DELEGATION_NOT_LIVE');

    // Nothing stored in either business, and no capture row moved.
    expect(await storedObjects(w, w.world.business)).toBe(before.alpha);
    expect(await storedObjects(w, w.beta)).toBe(before.beta);
    expect(await capturesOf(w, reviewed.revisionId)).toStrictEqual(claimed);
    expect(claimed.map((row) => [row.state, row.lease_id])).toStrictEqual([
      ['claimed', claiming.leaseId],
      ['claimed', claiming.leaseId],
    ]);
    expect(await capturesOf(w, betaRevision)).toStrictEqual(betaCaptures);
  }, 60_000);
});
