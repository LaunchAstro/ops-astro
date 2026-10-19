// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): a review is opened on a task for one of its holder's bound pages, and each
// open of the same page adds the next revision, numbered from one and digested. The read
// lists both, in number order, with the review's task, holder and page.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 open: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35open');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 review records', () => {
  it('C35 a review opens on a task and numbers its revisions', async () => {
    const first = await w.open(w.ava, { sourceRevision: 'rev-1' });
    const second = await w.open(w.ava, { sourceRevision: 'rev-2' });
    expect([codeOf(first), codeOf(second)]).toStrictEqual(['not-a-refusal', 'not-a-refusal']);
    const [one, two] = [detailOf(first), detailOf(second)];
    expect(two['reviewId']).toBe(one['reviewId']);
    expect([one['number'], two['number']]).toStrictEqual([1, 2]);
    expect(one['digest']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(two['digest']).not.toBe(one['digest']);

    expect(await w.read(w.ava, one['reviewId'])).toStrictEqual({
      ok: true,
      review: {
        reviewId: one['reviewId'],
        taskId: w.taskA,
        partyId: w.partyA,
        kind: 'page',
        pageUrl: PAGE,
        path: ABOUT,
        revisions: [
          { revisionId: one['revisionId'], number: 1, digest: one['digest'], captures: [] },
          { revisionId: two['revisionId'], number: 2, digest: two['digest'], captures: [] },
        ],
      },
    });
    expect(await w.count('reviews', w.world.business)).toBe(1);
    expect(await w.count('review_revisions', w.world.business)).toBe(2);
  });

  it('C35 two opens of one page at once land as revisions one and two of one review', async () => {
    const page = {
      taskId: w.taskB,
      pageUrl: 'https://client-b.example/team/',
      path: 'src/pages/team.md',
    };
    const both = await Promise.all([w.open(w.ava, page), w.open(w.ava, page)]);
    expect(both.map((one) => codeOf(one))).toStrictEqual(['not-a-refusal', 'not-a-refusal']);
    const details = both.map((one) => detailOf(one));
    expect(details[0]?.['reviewId']).toBe(details[1]?.['reviewId']);
    expect(details.map((detail) => detail['number']).toSorted()).toStrictEqual([1, 2]);
  });
});
