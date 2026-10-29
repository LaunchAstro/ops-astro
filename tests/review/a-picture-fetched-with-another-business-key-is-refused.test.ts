// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): a landed picture is read only inside its own business, by a grant that
// reaches its review. Alpha lands a picture of party A's page. eve, holding review read
// business-wide in beta, asks `review.picture` for that picture's id and is told NOT_FOUND,
// as she would be for an id that never existed: no bytes, and nothing of the picture's id or
// digest in what comes back. dee, whose grant in alpha is party B's only, is told the same.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { c35World, pickUpReviewed, underReview, type C35World } from './c35-world.ts';
import { claimUnder, landUnder, pictureBytes, readPicture, storedObjects } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 picture across businesses: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35picturekey');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 a picture stays in its business', () => {
  it("C35 a picture fetched with another business's key is refused", async () => {
    const reviewed = await underReview(w, 'a picture of alpha');
    const lease = await pickUpReviewed(w, reviewed);
    expect(codeOf(await claimUnder(w, lease, reviewed.revisionId))).toBe('not-a-refusal');
    const picture = pictureBytes(77);
    const { result } = await landUnder(w, lease, {
      revisionId: reviewed.revisionId,
      width: 1480,
      picture,
    });
    expect(codeOf(result)).toBe('not-a-refusal');
    const pictureId = String(detailOf(result)['pictureId']);
    const digest = String(detailOf(result)['pictureDigest']);
    const betaStored = await storedObjects(w, w.beta);

    // Its own business's reader gets the bytes.
    const own = await readPicture(w, w.ava, pictureId);
    expect(isCommandRefusal(own) ? own.code : 'not-a-refusal').toBe('not-a-refusal');

    const neverWas = await readPicture(w, w.eve, randomUUID(), w.beta);
    const answers = [
      await readPicture(w, w.eve, pictureId, w.beta),
      await readPicture(w, w.eve, pictureId.toUpperCase(), w.beta),
      await readPicture(w, w.dee, pictureId),
    ];
    for (const answer of answers) {
      expect(isCommandRefusal(answer) ? answer.code : 'not-a-refusal').toBe('NOT_FOUND');
      // The same answer as an id that never existed, naming nothing of the picture.
      expect(answer).toStrictEqual(neverWas);
      const body = JSON.stringify(answer);
      expect(body).not.toContain(pictureId);
      expect(body.toLowerCase()).not.toContain(pictureId.toLowerCase());
      expect(body).not.toContain(digest);
      expect(body).not.toContain(digest.replace('sha256:', ''));
      expect(body).not.toContain(picture.toString('base64'));
    }
    expect(await storedObjects(w, w.beta)).toBe(betaStored);
  }, 60_000);
});
