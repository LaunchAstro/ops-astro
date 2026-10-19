// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one revision's carry read top to bottom */
//
// C35-X (#2075, #2014 slice A): the worker carries a review's pins onto its new revision. A
// pin is found again only when its spot is unchanged (the same document at that width, so
// the region carries as it was) or its quote, with its context, occurs exactly once in the
// new page's text, which carries the quote and no coordinate. Repeated text, a changed
// region or a missing quote is an anchor lost: carried with no anchor at all, still open,
// and first in the review read. The comment and its first anchor are left as they were.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { c35World, spot, type C35World } from './c35-world.ts';
import {
  carriesOnto,
  carryUnder,
  commentRows,
  landPage,
  landedReview,
  must,
  nextRevision,
  pinOn,
  quote,
} from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X carry found again: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xcarry');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const FIRST = {
  text: 'Welcome to Harbour Physio. Book a visit today. Our team. Our team.',
  document: 'a',
};
const CHANGED = {
  text: 'Welcome to Harbour Health. Book a visit today. Our team. Our team. Visit us.',
  document: 'c',
};

/** What the review read says of the carry onto its latest revision. */
interface CarryRead {
  readonly carryDue: boolean;
  readonly carried: readonly {
    readonly commentId: string;
    readonly audience: string;
    readonly body: string;
    readonly fromRevisionId: string;
    readonly lost: boolean;
    readonly anchor: unknown;
  }[];
  readonly pins: readonly { readonly anchor: { readonly source: string } }[];
}

const readReview = async (reviewId: string): Promise<CarryRead> => {
  const read = await w.read(w.ava, reviewId);
  if (isCommandRefusal(read) || !('review' in read)) {
    throw new Error(`review.read answered ${JSON.stringify(read)}`);
  }
  return read.review as unknown as CarryRead;
};

describe.skipIf(serverUrl === undefined)('C35-X pins carried to a new revision', () => {
  it('C35-X a pin found again moves to the same spot, and a lost anchor is carried flagged and stays open', async () => {
    const { reviewed, lease } = await landedReview(w, 'carry on changed text', FIRST);
    const first = reviewed.revisionId;
    const regionOnly = await pinOn(w, first);
    const unique = await pinOn(w, first, {
      selector: [spot('xywh=40,120,400,32'), quote('Book a visit today')],
    });
    const repeated = await pinOn(w, first, {
      selector: [spot('xywh=40,200,200,32'), quote('Our team')],
    });
    const missing = await pinOn(w, first, {
      selector: [spot('xywh=40,20,300,40'), quote('Harbour Physio')],
    });
    const inContext = await pinOn(w, first, {
      audience: 'client',
      width: 390,
      body: 'Is this the right booking line?',
      selector: [
        spot('xywh=0,300,390,40'),
        quote('visit', { prefix: 'Book a ', suffix: ' today' }),
      ],
    });

    const second = await nextRevision(w, reviewed);
    await landPage(w, lease, second, CHANGED);
    expect((await readReview(reviewed.reviewId)).carryDue).toBe(true);
    const comments = await commentRows(w, reviewed.taskId);

    const carried = await carryUnder(w, lease, second);
    expect(must(carried.result, 'review.carry_pins')).toStrictEqual({
      revisionId: second,
      moved: 2,
      lost: 3,
    });

    // Stored: each pin once, from the revision it was on; a lost one with no anchor at all.
    const quoted = {
      source: second,
      width: 1480,
      selector: [quote('Book a visit today')],
    };
    const narrow = {
      source: second,
      width: 390,
      selector: [quote('visit', { prefix: 'Book a ', suffix: ' today' })],
    };
    const expected = [
      [regionOnly, 'lost', null],
      [unique, 'moved', quoted],
      [repeated, 'lost', null],
      [missing, 'lost', null],
      [inContext, 'moved', narrow],
    ] as const;
    expect(await carriesOnto(w, second)).toStrictEqual(
      expected
        .map(([commentId, state, anchor]) => ({
          comment_id: commentId,
          from_revision_id: first,
          state,
          anchor,
          operation_id: carried.operationId,
        }))
        .toSorted((a, b) => a.comment_id.localeCompare(b.comment_id)),
    );

    // The comments, their audiences, authors and first anchors are as they were: still open.
    expect(await commentRows(w, reviewed.taskId)).toStrictEqual(comments);

    // The review read: lost pins first, flagged, with no coordinate; then the moved ones.
    const review = await readReview(reviewed.reviewId);
    expect(review.carryDue).toBe(false);
    expect(review.carried.map((pin) => [pin.commentId, pin.lost, pin.anchor])).toStrictEqual([
      [regionOnly, true, null],
      [repeated, true, null],
      [missing, true, null],
      [unique, false, quoted],
      [inContext, false, narrow],
    ]);
    expect(review.carried.at(-1)).toMatchObject({
      audience: 'client',
      body: 'Is this the right booking line?',
      fromRevisionId: first,
    });
    expect(review.pins.every((pin) => pin.anchor.source === first)).toBe(true);
  }, 90_000);

  it('C35-X an unchanged page carries the spot as it was, and the next revision carries from the last spot found', async () => {
    const { reviewed, lease } = await landedReview(w, 'carry on an unchanged page', FIRST);
    const first = reviewed.revisionId;
    const regionOnly = await pinOn(w, first);
    const unique = await pinOn(w, first, {
      selector: [spot('xywh=40,120,400,32'), quote('Book a visit today')],
    });

    // The same document again: the region is unchanged, so every selector carries as it was.
    const second = await nextRevision(w, reviewed);
    await landPage(w, lease, second, FIRST);
    must((await carryUnder(w, lease, second)).result, 'review.carry_pins');
    const placed = (await readReview(reviewed.reviewId)).carried.map((pin) => [
      pin.commentId,
      pin.anchor,
    ]);
    expect(placed.toSorted()).toStrictEqual(
      [
        [regionOnly, { source: second, width: 1480, selector: [spot()] }],
        [
          unique,
          {
            source: second,
            width: 1480,
            selector: [spot('xywh=40,120,400,32'), quote('Book a visit today')],
          },
        ],
      ].toSorted(),
    );

    // A changed third revision carries from the second's spots: the quote is found again, the
    // coordinate alone is lost.
    const third = await nextRevision(w, reviewed);
    await landPage(w, lease, third, CHANGED);
    must((await carryUnder(w, lease, third)).result, 'review.carry_pins');
    const onThird = await carriesOnto(w, third);
    expect(
      onThird.map((row) => [row.comment_id, row.from_revision_id, row.state]).toSorted(),
    ).toStrictEqual(
      [
        [regionOnly, second, 'lost'],
        [unique, second, 'moved'],
      ].toSorted(),
    );
  }, 90_000);
});
