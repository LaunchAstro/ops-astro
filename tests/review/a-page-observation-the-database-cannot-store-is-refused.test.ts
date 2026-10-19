// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011, Sol S2121-3): a page observation Postgres cannot keep as jsonb (a NUL character,
// or half a surrogate pair, in a value or a key) is refused as a field, never raised as a database
// fault, and stores nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, underReview, pickUpReviewed, type C35World } from './c35-world.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import {
  claimUnder,
  underLease,
  observationOf,
  pictureBytes,
  storedObjects,
} from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('sol2121null');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 an unstorable page observation', () => {
  it('an agent’s observation holding a NUL character is refused FIELD_VALUE_INVALID and stores nothing', async () => {
    const reviewed = await underReview(w, 'Sol unstorable page observation');
    const lease = await pickUpReviewed(w, reviewed);
    expect(codeOf(await claimUnder(w, lease, reviewed.revisionId))).toBe('not-a-refusal');
    const before = await storedObjects(w, w.world.business);
    await expect(
      underLease(w, lease, {
        command: 'review.capture_land',
        revisionId: reviewed.revisionId,
        width: 1480,
        picture: pictureBytes(4).toString('base64'),
        observation: {
          ...observationOf(1480),
          text: 'a page string with ' + String.fromCodePoint(0),
        },
      }),
    ).resolves.toMatchObject({ result: { code: 'FIELD_VALUE_INVALID' } });
    expect(await storedObjects(w, w.world.business)).toBe(before);
  }, 60_000);

  it('an observation holding a lone surrogate, in a value or a key, is refused FIELD_VALUE_INVALID and stores nothing', async () => {
    const reviewed = await underReview(w, 'an observation jsonb cannot parse');
    const lease = await pickUpReviewed(w, reviewed);
    expect(codeOf(await claimUnder(w, lease, reviewed.revisionId))).toBe('not-a-refusal');
    const before = await storedObjects(w, w.world.business);
    const lone = String.fromCodePoint(0xd8_00);
    const seen = observationOf(1480);
    for (const observation of [
      { ...seen, html: `<p>half a pair ${lone}</p>` },
      { ...seen, stylesheets: { [`sheet${lone}`]: 'sha256:0' } },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one land at a time on one lease
      const landed = await underLease(w, lease, {
        command: 'review.capture_land',
        revisionId: reviewed.revisionId,
        width: 1480,
        picture: pictureBytes(5).toString('base64'),
        observation,
      });
      expect(landed).toMatchObject({ result: { code: 'FIELD_VALUE_INVALID' } });
    }
    expect(await storedObjects(w, w.world.business)).toBe(before);
  }, 60_000);
});
