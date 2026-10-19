// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each proof reads top to bottom, its refusals beside the pin they would have kept */
//
// C35 (#2012): `review.pin_comment` keeps a comment on the review's task whose anchor is a
// W3C Web Annotation target, and `review.read` returns it as written. A pin binds to its own
// width's capture; one off the capture, on a width with no capture or on an unknown revision
// is refused and keeps nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 pins: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35pins');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const QUOTE = { type: 'TextQuoteSelector', exact: 'Book a visit', suffix: ' today' } as const;

/** A review on task A with its first revision, both widths asked. */
async function captured(): Promise<{ readonly reviewId: string; readonly revisionId: string }> {
  const opened = detailOf(await w.open(w.ava));
  expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
  return { reviewId: String(opened['reviewId']), revisionId: String(opened['revisionId']) };
}

async function pinsOf(reviewId: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const read = await w.read(w.ava, reviewId);
  if (!('review' in read)) throw new Error(`review.read refused: ${JSON.stringify(read)}`);
  return (read.review as unknown as { readonly pins: readonly Record<string, unknown>[] }).pins;
}

describe.skipIf(serverUrl === undefined)('C35 pins', () => {
  it('C35 a pin reads back as a Web Annotation target', async () => {
    const { reviewId, revisionId } = await captured();
    const selector = [spot('xywh=120,340,300,48'), QUOTE];
    const pinned = await w.pin(w.ava, revisionId.toUpperCase(), { selector });
    expect(codeOf(pinned)).toBe('not-a-refusal');
    const commentId = detailOf(pinned)['commentId'];

    expect(await pinsOf(reviewId)).toStrictEqual([
      {
        commentId,
        audience: 'internal',
        body: 'Move this heading above the fold',
        anchor: { source: revisionId, width: 1480, selector },
      },
    ]);

    const before = await w.count('pins', w.world.business);
    const refusals = [
      [{ selector: [spot('xywh=1400,0,81,10')] }, 'FIELD_VALUE_INVALID'],
      [{ width: 900 }, 'FIELD_VALUE_INVALID'],
      [{ selector: [{ ...spot(), type: 'SvgSelector' }] }, 'FIELD_VALUE_INVALID'],
      [{ selector: [spot(), { ...QUOTE, exact: '' }] }, 'FIELD_VALUE_INVALID'],
      [{ body: '' }, 'FIELD_VALUE_INVALID'],
      [{ audience: 'everyone' }, 'FIELD_VALUE_INVALID'],
    ] as const;
    for (const [overrides, code] of refusals) {
      // eslint-disable-next-line no-await-in-loop -- each refusal after the last, counted after all
      expect(codeOf(await w.pin(w.ava, revisionId, overrides)), JSON.stringify(overrides)).toBe(
        code,
      );
    }
    expect(codeOf(await w.pin(w.ava, randomUUID()))).toBe('NOT_FOUND');
    expect(codeOf(await w.pin(w.ava, 'not-a-revision'))).toBe('NOT_FOUND');
    expect(await w.count('pins', w.world.business)).toBe(before);
    expect(await pinsOf(reviewId)).toHaveLength(1);
  });

  it('C35 a pin on the desktop and on the phone capture', async () => {
    const { reviewId, revisionId } = await captured();
    const desktop = detailOf(await w.pin(w.ava, revisionId, { body: 'desktop spot' }));
    const phone = detailOf(
      await w.pin(w.ava, revisionId, {
        width: 390,
        selector: [spot('xywh=pixel:10,900,370,60')],
        body: 'phone spot',
      }),
    );
    // A spot inside the desktop capture is off the phone's.
    expect(codeOf(await w.pin(w.ava, revisionId, { width: 390 }))).toBe('FIELD_VALUE_INVALID');

    const pins = await pinsOf(reviewId);
    const byBody = new Map(pins.map((pin) => [pin['body'], pin]));
    expect(byBody.get('desktop spot')).toMatchObject({
      commentId: desktop['commentId'],
      anchor: { source: revisionId, width: 1480, selector: [spot()] },
    });
    expect(byBody.get('phone spot')).toMatchObject({
      commentId: phone['commentId'],
      anchor: { source: revisionId, width: 390, selector: [spot('xywh=pixel:10,900,370,60')] },
    });
  });

  it('a revision whose captures were never asked takes no pin', async () => {
    const opened = detailOf(await w.open(w.ava));
    const before = await w.count('pins', w.world.business);
    expect(codeOf(await w.pin(w.ava, opened['revisionId']))).toBe('FIELD_VALUE_INVALID');
    expect(await w.count('pins', w.world.business)).toBe(before);
  });
});
