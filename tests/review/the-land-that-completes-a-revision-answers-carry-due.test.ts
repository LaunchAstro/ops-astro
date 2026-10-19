// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each proof lands its revisions and races them in one place */
//
// C35-X (#2075, S2165-2): `review.capture_land` tells its worker when to carry. The land that
// completes a revision's last width answers `carryDue: true` while a pin before it is not yet
// carried onto it; every other land answers false: an earlier width, a first revision with no
// pin before it, and a revision whose pins are carried. Two lands of one revision's widths at
// once, on separate connections, run one at a time, so exactly one of them answers true.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
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

type Connection = ReturnType<typeof connect>;

/** Land one width of `revisionId` under `lease`, on `database` if given; its `carryDue`. */
async function landDue(
  lease: Lease,
  revisionId: string,
  width: number,
  database?: Connection,
): Promise<unknown> {
  const { result } = await underLease(
    w,
    lease,
    {
      command: 'review.capture_land',
      revisionId,
      width,
      picture: pictureBytes(width).toString('base64'),
      observation: observed(width, PAGE),
    },
    database,
  );
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

/** Wait until `count` statements wait on an advisory lock, as lands do on the audit chain. */
async function untilWaiting(count: number): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const [row] = await w.world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and wait_event = 'advisory'`,
    );
    if (Number(row?.n) >= count) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

describe.skipIf(serverUrl === undefined)('C35-X the land answers whether a carry is due', () => {
  it('only the land completing a revision with an uncarried pin before it answers carryDue', async () => {
    const { lease, next } = await pinnedThenNext('Carry due on the last land');
    expect(await landDue(lease, next, 1480)).toBe(false);
    expect(await landDue(lease, next, 390)).toBe(true);
    must((await carryUnder(w, lease, next)).result, 'review.carry_pins');
  }, 120_000);

  it('two lands of one revision at once run one at a time and one answers carryDue', async () => {
    const { lease, next } = await pinnedThenNext('Carry due on lands at once');
    const blocker = connect(w.world.db.appUrl);
    const one = connect(w.world.db.appUrl);
    const two = connect(w.world.db.appUrl);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    // The business's audit chain held, so neither land can finish before the other has run.
    const held = blocker.withBusiness(w.world.business, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        w.world.business.toLowerCase(),
      ]);
      ready();
      await gate;
    });
    try {
      await locked;
      const lands = Promise.all([landDue(lease, next, 1480, one), landDue(lease, next, 390, two)]);
      try {
        expect(await untilWaiting(2), 'both lands wait on the audit chain').toBe(true);
      } finally {
        release();
        await held;
      }
      expect((await lands).toSorted()).toEqual([false, true]);
    } finally {
      await Promise.all([blocker.close(), one.close(), two.close()]);
    }
  }, 120_000);
});
