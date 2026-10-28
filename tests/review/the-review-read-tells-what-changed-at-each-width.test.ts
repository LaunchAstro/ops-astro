// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105): `review.read` tells, for each width, what changed between the previous
// revision's landed observation and this one's: the run of text that moved and each
// stylesheet whose digest changed, came or went. A first revision has no difference, nor has
// a width not yet landed on both; a width landed the same on both reads as nothing changed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, pickUpReviewed, underReview, PAGE, type C35World } from './c35-world.ts';
import { claimUnder, landUnder, pictureBytes } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 difference: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35diff');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const SITE = 'https://agency.example/site.css';
const PRINT = 'https://agency.example/print.css';
const FONTS = 'https://agency.example/fonts.css';
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

const observed = (text: string, stylesheets: Readonly<Record<string, string>>) => ({
  url: PAGE,
  documentDigest: digest('d'),
  text,
  html: `<main><p>${text}</p></main>`,
  status: 200,
  stylesheets,
});

const BEFORE_SHEETS = { [SITE]: digest('a'), [PRINT]: digest('b') };

async function differencesOf(reviewId: string): Promise<unknown> {
  const read = await w.read(w.ava, reviewId);
  if (!('review' in read)) throw new Error(`review.read refused: ${JSON.stringify(read)}`);
  return (read.review as unknown as { readonly differences: unknown }).differences;
}

/** A review with a second revision asked, both claimed under one lease, and their land. */
async function twoRevisions() {
  const first = await underReview(w, 'Review the about page wording');
  const second = detailOf(await w.open(w.ava, { taskId: first.taskId }));
  expect(second['reviewId']).toBe(first.reviewId);
  const secondRevision = String(second['revisionId']);
  expect(codeOf(await w.capture(w.ava, secondRevision))).toBe('not-a-refusal');
  const lease = await pickUpReviewed(w, first);
  expect(codeOf(await claimUnder(w, lease, first.revisionId))).toBe('not-a-refusal');
  expect(codeOf(await claimUnder(w, lease, secondRevision))).toBe('not-a-refusal');
  let seed = 0;
  const land = async (revisionId: string, width: number, observation: object) =>
    codeOf(
      (
        await landUnder(w, lease, {
          revisionId,
          width,
          picture: pictureBytes((seed += 1)),
          observation: observation as Readonly<Record<string, unknown>>,
        })
      ).result,
    );

  return { first, secondRevision, land };
}

describe.skipIf(serverUrl === undefined)('C35 difference', () => {
  it('C35 before and after at laptop and phone size', async () => {
    const { first, secondRevision, land } = await twoRevisions();

    // The first revision landed at both widths: nothing to compare it with.
    const wideBefore = observed('We fix bikes in Townsville since 2004.', BEFORE_SHEETS);
    const narrowBefore = observed('We fix bikes.', BEFORE_SHEETS);
    expect(await land(first.revisionId, 1480, wideBefore)).toBe('not-a-refusal');
    expect(await land(first.revisionId, 390, narrowBefore)).toBe('not-a-refusal');
    expect(await differencesOf(first.reviewId)).toStrictEqual([]);

    // The second revision landed at laptop size only: the phone width has no difference yet.
    const wideAfter = observed('We fix e-bikes in Townsville since 2004.', {
      [SITE]: digest('c'),
      [FONTS]: digest('f'),
    });
    expect(await land(secondRevision, 1480, wideAfter)).toBe('not-a-refusal');
    const laptop = {
      width: 1480,
      text: { at: 7, removed: '', added: 'e-' },
      stylesheets: [
        { address: FONTS, before: null, after: digest('f') },
        { address: PRINT, before: digest('b'), after: null },
        { address: SITE, before: digest('a'), after: digest('c') },
      ],
    };
    expect(await differencesOf(first.reviewId)).toStrictEqual([laptop]);

    // The phone width landed as it was: compared, and nothing changed.
    expect(await land(secondRevision, 390, narrowBefore)).toBe('not-a-refusal');
    expect(await differencesOf(first.reviewId)).toStrictEqual([
      laptop,
      { width: 390, text: null, stylesheets: [] },
    ]);

    // A third revision, not yet landed, is compared with nothing.
    detailOf(await w.open(w.ava, { taskId: first.taskId }));
    expect(await differencesOf(first.reviewId)).toStrictEqual([]);
  });
});
