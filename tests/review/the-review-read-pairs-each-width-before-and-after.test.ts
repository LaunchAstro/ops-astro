// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2012): `review.read` pairs the revision under review with the one before it, at
// laptop and phone size: the previous revision's captures beside this one's. A first revision
// has no before. The text and stylesheet differences wait for the landed observations (#2105).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 before and after: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35pair');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const BOTH = [
  { width: 1480, state: 'requested', pictureId: null, pictureDigest: null, observation: null },
  { width: 390, state: 'requested', pictureId: null, pictureDigest: null, observation: null },
];

async function pairOf(reviewId: unknown) {
  const read = await w.read(w.ava, reviewId);
  if (!('review' in read)) throw new Error(`review.read refused: ${JSON.stringify(read)}`);
  const { before, after } = read.review as unknown as Readonly<Record<string, unknown>>;
  return { before, after };
}

/** A revision as the read shows it: undecided, as every revision here is. */
const shown = (
  opened: Readonly<Record<string, unknown>>,
  number: number,
  captures: readonly unknown[],
) => ({
  revisionId: opened['revisionId'],
  number,
  digest: opened['digest'],
  captures,
  decision: null,
  correctionId: null,
});

describe.skipIf(serverUrl === undefined)('C35 before and after', () => {
  it('C35 before and after at laptop and phone size', async () => {
    const first = detailOf(await w.open(w.ava));
    expect(await pairOf(first['reviewId'])).toStrictEqual({
      before: null,
      after: shown(first, 1, []),
    });
    expect(codeOf(await w.capture(w.ava, first['revisionId']))).toBe('not-a-refusal');
    expect(await pairOf(first['reviewId'])).toStrictEqual({
      before: null,
      after: shown(first, 1, BOTH),
    });

    const second = detailOf(await w.open(w.ava));
    expect(second['reviewId']).toBe(first['reviewId']);
    expect(codeOf(await w.capture(w.ava, second['revisionId']))).toBe('not-a-refusal');
    expect(await pairOf(first['reviewId'])).toStrictEqual({
      before: shown(first, 1, BOTH),
      after: shown(second, 2, BOTH),
    });

    const third = detailOf(await w.open(w.ava));
    expect(await pairOf(first['reviewId'])).toStrictEqual({
      before: shown(second, 2, BOTH),
      after: shown(third, 3, []),
    });
  });
});
