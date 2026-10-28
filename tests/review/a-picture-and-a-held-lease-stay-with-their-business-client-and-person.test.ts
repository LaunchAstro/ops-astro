// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011, Sol round 1 separation proofs): the storage seam puts, gets and deletes only in its
// own business and holds the exact byte cap; another person cannot use a held lease, and another
// client cannot read its picture.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, underReview, pickUpReviewed, type C35World } from './c35-world.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { DATABASE_STORAGE } from '../../packages/core-records/src/review/storage.ts';
import { claimUnder, landUnder, pictureBytes, readPicture } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('sol2121sep');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)(
  'C35 pictures and leases across business, client and person',
  // eslint-disable-next-line max-lines-per-function -- one world, and the two crossings that share it
  () => {
    it('the storage seam keeps to its business and holds the exact byte cap', async () => {
      const body = pictureBytes(7, 512 * 1024);
      const stored = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        expect(await DATABASE_STORAGE.put(tx, new Uint8Array())).toStrictEqual({
          refused: 'OBJECT_EMPTY',
        });
        expect(await DATABASE_STORAGE.put(tx, pictureBytes(1, 512 * 1024 + 1))).toStrictEqual({
          refused: 'OBJECT_TOO_LARGE',
        });
        return await DATABASE_STORAGE.put(tx, body);
      });
      if ('refused' in stored) throw new Error(stored.refused);
      await w.world.db.app.withBusiness(w.beta, async (tx) => {
        expect(await DATABASE_STORAGE.get(tx, stored.id)).toBeUndefined();
        expect(await DATABASE_STORAGE.delete(tx, stored.id)).toBe(false);
      });
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        const read = await DATABASE_STORAGE.get(tx, stored.id);
        expect(Buffer.from(read!.body).equals(body)).toBe(true);
        expect(await DATABASE_STORAGE.delete(tx, stored.id)).toBe(true);
        expect(await DATABASE_STORAGE.get(tx, stored.id)).toBeUndefined();
      });
    });
    it('another person cannot use a held lease, and another client cannot read its picture', async () => {
      const reviewed = await underReview(w, 'Sol separation');
      const lease = await pickUpReviewed(w, reviewed);
      // Ben has task write himself, but the lease is the agent's, never Ben's.
      expect(
        codeOf(
          await w.as(w.ben, {
            command: 'review.capture_claim',
            leaseId: lease.leaseId,
            fence: lease.fence,
            revisionId: reviewed.revisionId,
          }),
        ),
      ).toBe('LEASE_NOT_OWNED');
      expect(codeOf(await claimUnder(w, lease, reviewed.revisionId))).toBe('not-a-refusal');
      const landed = await landUnder(w, lease, {
        revisionId: reviewed.revisionId,
        width: 1480,
        picture: pictureBytes(8),
      });
      expect(codeOf(landed.result)).toBe('not-a-refusal');
      if ('code' in landed.result) throw new Error('land refused');
      const pictureId = landed.result.detail['pictureId'];
      expect(await readPicture(w, w.dee, pictureId)).toMatchObject({ code: 'NOT_FOUND' });
      expect(await readPicture(w, w.eve, pictureId, w.beta)).toMatchObject({ code: 'NOT_FOUND' });
      expect(await readPicture(w, w.ava, pictureId)).toMatchObject({
        ok: true,
        picture: { pictureId },
      });
    });
  },
);
