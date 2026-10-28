// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): the page under review is one its task's holder's site binds, the R6-S2 rule
// read from the bound-pages catalogue. Another client's page, a page no site binds, or a
// page unbound since the review opened is refused, and nothing is stored. A capture asked
// of a bound page is one row per width, requested, and a second ask of the same revision is
// refused.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { unbindPartySitePage } from '../../packages/core-records/src/site/party-sites.ts';
import { ASTRO_FILE, ASTRO_PAGE } from '../site/c80-sites.ts';
import { B_FILE, B_PAGE, c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 bound page: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35bound');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const stored = async () => ({
  reviews: await w.count('reviews', w.world.business),
  revisions: await w.count('review_revisions', w.world.business),
  captures: await w.count('review_captures', w.world.business),
});

describe.skipIf(serverUrl === undefined)('C35 the bound pages', () => {
  it("C35 a capture is asked only for a bound page of the task's holder", async () => {
    const before = await stored();
    // Party B's page on party A's task, and a page no site binds.
    expect(codeOf(await w.open(w.ava, { pageUrl: B_PAGE, path: B_FILE }))).toBe(
      'PAGE_OUTSIDE_HOLDER_SITE',
    );
    expect(
      codeOf(await w.open(w.ava, { pageUrl: 'https://agency.example/nowhere/', path: 'x.md' })),
    ).toBe('PAGE_OUTSIDE_HOLDER_SITE');
    expect(await stored()).toStrictEqual(before);

    // A bound page, then unbound: its capture is refused and stores nothing.
    const opened = detailOf(await w.open(w.ava, { pageUrl: ASTRO_PAGE, path: ASTRO_FILE }));
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await unbindPartySitePage(tx, w.partyA, ASTRO_PAGE);
    });
    expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('PAGE_OUTSIDE_HOLDER_SITE');
    expect((await stored()).captures).toBe(before.captures);
  });

  it('C35 a capture of a bound page asks both widths once', async () => {
    const opened = detailOf(await w.open(w.ava));
    const asked = await w.capture(w.ava, opened['revisionId']);
    expect(detailOf(asked)).toStrictEqual({
      reviewId: opened['reviewId'],
      revisionId: opened['revisionId'],
      widths: [1480, 390],
    });
    expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('CAPTURE_ALREADY_ASKED');
    const read = await w.read(w.ava, opened['reviewId']);
    const revision = 'review' in read ? read.review.revisions.at(-1) : undefined;
    expect(revision?.captures).toStrictEqual([
      { width: 1480, state: 'requested', pictureId: null, pictureDigest: null, observation: null },
      { width: 390, state: 'requested', pictureId: null, pictureDigest: null, observation: null },
    ]);
  });
});
