// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each proof reads top to bottom, its refusals beside the pin they would have kept */
//
// C35-X (#2120): a pin made on the live view goes through `review.pin_comment` with the captured
// revision and width, and is kept on that capture only where the live view corresponds to it:
// the frame was at the capture's width, the revision is the newest, its capture at that width
// has landed, and the spot is a place on that capture, with no text read from the live page.
// Anything else is refused with the ask for a fresh capture, and keeps nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { c35World, pickUpReviewed, spot, type C35World, type Lease } from './c35-world.ts';
import { claimUnder, landUnder, pictureBytes } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X live pins: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xlivepin');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A new revision of task A's review, both widths asked. */
async function captured(): Promise<{ readonly reviewId: string; readonly revisionId: string }> {
  const opened = detailOf(await w.open(w.ava));
  expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
  return { reviewId: String(opened['reviewId']), revisionId: String(opened['revisionId']) };
}

let lease: Lease | undefined;

/** The capture at `width` landed by the capture worker: claimed under its lease on task A, then landed with a picture. */
async function land(revisionId: string, width: number): Promise<void> {
  const reviewId = String(
    (
      await w.world.db.admin.execute<{ readonly review_id: string }>(
        'select review_id from public.review_revisions where business_id = $1 and id = $2',
        [w.world.business, revisionId],
      )
    )[0]?.review_id,
  );
  lease ??= await pickUpReviewed(w, { taskId: w.taskA, reviewId, revisionId });
  expect(codeOf(await claimUnder(w, lease, revisionId))).toBe('not-a-refusal');
  const landed = await landUnder(w, lease, { revisionId, width, picture: pictureBytes(width) });
  expect(codeOf(landed.result)).toBe('not-a-refusal');
}

const fixesOf = (result: CommandResult): readonly string[] =>
  isCommandRefusal(result) ? result.fixes : [];
const namesOf = (result: CommandResult): readonly string[] =>
  isCommandRefusal(result) ? result.names : [];

const live = (width: number, viewport = width) => ({ width, liveViewport: viewport });

describe.skipIf(serverUrl === undefined)('C35-X live-view pins', () => {
  it('C35-X a live-view pin is saved against the capture', async () => {
    const { reviewId, revisionId } = await captured();
    await land(revisionId, 1480);

    const pinned = await w.pin(w.ava, revisionId, { ...live(1480), body: 'seen live' });
    expect(codeOf(pinned)).toBe('not-a-refusal');
    const read = await w.read(w.ava, reviewId);
    if (!('review' in read)) throw new Error(`review.read refused: ${JSON.stringify(read)}`);
    // The pin is the capture's: the same Web Annotation target a pin on the picture keeps.
    expect(read.review.pins).toStrictEqual([
      {
        commentId: detailOf(pinned)['commentId'],
        audience: 'internal',
        body: 'seen live',
        anchor: { source: revisionId, width: 1480, selector: [spot()] },
      },
    ]);
  });

  it('a live view that does not correspond to the capture asks a fresh capture and keeps nothing', async () => {
    const first = await captured();
    await land(first.revisionId, 1480);
    const before = await w.count('pins', w.world.business);

    // The frame was not at the capture's width.
    const narrow = await w.pin(w.ava, first.revisionId, live(1480, 1280));
    expect([codeOf(narrow), namesOf(narrow)]).toStrictEqual([
      'FIELD_VALUE_INVALID',
      ['liveViewport'],
    ]);
    // The phone capture is asked and has not landed: there is no picture the spot is on.
    const unlanded = await w.pin(w.ava, first.revisionId, {
      ...live(390),
      selector: [spot('xywh=10,40,100,48')],
    });
    expect([codeOf(unlanded), namesOf(unlanded)]).toStrictEqual([
      'FIELD_VALUE_INVALID',
      ['revisionId'],
    ]);
    expect(fixesOf(unlanded).join(' ')).toMatch(/fresh capture/u);
    // Text read from the live page is a claim about the live page, never the capture's.
    const quoted = await w.pin(w.ava, first.revisionId, {
      ...live(1480),
      selector: [spot(), { type: 'TextQuoteSelector', exact: 'Book a visit' }],
    });
    expect([codeOf(quoted), namesOf(quoted)]).toStrictEqual(['FIELD_VALUE_INVALID', ['selector']]);
    for (const viewport of ['1480', 1480.5, -1480, null]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal after the last
      const refused = await w.pin(w.ava, first.revisionId, live(1480, viewport as number));
      expect(codeOf(refused), String(viewport)).toBe('FIELD_VALUE_INVALID');
    }

    // A newer revision: the live view is beside it, so the older capture no longer matches.
    const second = await captured();
    expect(second.reviewId).toBe(first.reviewId);
    await land(second.revisionId, 1480);
    const older = await w.pin(w.ava, first.revisionId, live(1480));
    expect([codeOf(older), namesOf(older)]).toStrictEqual(['FIELD_VALUE_INVALID', ['revisionId']]);
    expect(fixesOf(older).join(' ')).toMatch(/fresh capture/u);
    expect(await w.count('pins', w.world.business)).toBe(before);

    // A pin on the older capture's picture is still a pin on that capture.
    expect(codeOf(await w.pin(w.ava, first.revisionId))).toBe('not-a-refusal');
    expect(codeOf(await w.pin(w.ava, second.revisionId, live(1480)))).toBe('not-a-refusal');
    expect(await w.count('pins', w.world.business)).toBe(before + 2);
  });
});
