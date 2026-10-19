// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105), isolation for the difference read: a review on client A's task and one on
// client B's, each with a second revision landed whose text names a planted marker. dee holds
// the review keys on client B only and eve holds them in another business. dee reads client
// B's difference and nothing of client A's; client A's review answers dee and eve one
// NOT_FOUND, and no answer shows client A's marker.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import {
  ABOUT,
  B_FILE,
  B_PAGE,
  c35World,
  pickUpReviewed,
  underReview,
  PAGE,
  type C35World,
} from './c35-world.ts';
import { claimUnder, landUnder, pictureBytes } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 difference isolation: DATABASE_URL is unset.');

const MARKER_A = 'planted-difference-marker-a7c3';
const MARKER_B = 'planted-difference-marker-b5e1';

let w: C35World;
let seed = 100;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35diffiso');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A review with two revisions landed at laptop size, the second's text naming `marker`. */
async function changedReview(
  at: { readonly partyId: string; readonly pageUrl: string; readonly path: string },
  marker: string,
): Promise<string> {
  const first = await underReview(w, `Review ${marker}`, at);
  const second = String(
    detailOf(await w.open(w.ava, { taskId: first.taskId, pageUrl: at.pageUrl, path: at.path }))[
      'revisionId'
    ],
  );
  expect(codeOf(await w.capture(w.ava, second))).toBe('not-a-refusal');
  const lease = await pickUpReviewed(w, first);
  const landOn = async (revisionId: string, text: string) => {
    expect(codeOf(await claimUnder(w, lease, revisionId))).toBe('not-a-refusal');
    const landed = await landUnder(w, lease, {
      revisionId,
      width: 1480,
      picture: pictureBytes((seed += 1)),
      observation: {
        url: at.pageUrl,
        documentDigest: `sha256:${'d'.repeat(64)}`,
        text,
        html: `<p>${text}</p>`,
        status: 200,
        stylesheets: {},
      },
    });
    expect(codeOf(landed.result)).toBe('not-a-refusal');
  };
  await landOn(first.revisionId, 'Opening hours');
  await landOn(second, `Opening hours ${marker}`);
  return first.reviewId;
}

describe.skipIf(serverUrl === undefined)('C35 difference isolation', () => {
  it('C35 isolation for the difference read', async () => {
    const onA = await changedReview({ partyId: w.partyA, pageUrl: PAGE, path: ABOUT }, MARKER_A);
    const onB = await changedReview({ partyId: w.partyB, pageUrl: B_PAGE, path: B_FILE }, MARKER_B);

    // Positive control: ava, business-wide, sees client A's marker in its difference.
    const avaRead = await w.read(w.ava, onA);
    expect(JSON.stringify(avaRead)).toContain(MARKER_A);

    const answers: unknown[] = [];
    // Another client in the same business: dee reads client B's difference only.
    const deeOnB = await w.read(w.dee, onB);
    answers.push(deeOnB);
    if (!('review' in deeOnB)) throw new Error('dee cannot read client B review');
    expect(
      (deeOnB.review as unknown as { readonly differences: unknown }).differences,
    ).toStrictEqual([
      { width: 1480, text: { at: 13, removed: '', added: ` ${MARKER_B}` }, stylesheets: [] },
    ]);
    const deeOnA = await w.read(w.dee, onA);
    answers.push(deeOnA);
    expect(deeOnA).toMatchObject({ code: 'NOT_FOUND' });

    // Another business: eve's grant covers beta only, so alpha's review is no review.
    const eveOnA = await w.read(w.eve, onA, w.beta);
    answers.push(eveOnA);
    expect(eveOnA).toMatchObject({ code: 'NOT_FOUND' });

    const shown = JSON.stringify(answers);
    expect(shown).not.toContain(MARKER_A);
    expect(shown).not.toContain(onA);
  });
});
