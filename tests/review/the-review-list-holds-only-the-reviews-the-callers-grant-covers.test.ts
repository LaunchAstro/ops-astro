// SPDX-License-Identifier: AGPL-3.0-only
//
// The Reviews page's read (`review.list`): the business's reviews the caller's `review:read`
// covers, filtered inside the query as `review.read` is. Three crossings: another business
// (eve in beta), another client in the same business (dee holds party B only) and another
// person with no review key (cal). No answer, a refusal included, carries a foreign review's
// id or page.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Member } from '../commands/fixture.ts';
import { B_FILE, B_PAGE, c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('revlist');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const list = async (member: Member, business = w.world.business) =>
  (await executeRead(w.world.db.app, business, member.presented, {
    read: 'review.list',
  } as never)) as unknown as Readonly<Record<string, unknown>>;

const ids = (answer: Readonly<Record<string, unknown>>): readonly string[] =>
  ((answer['reviews'] ?? []) as readonly { readonly reviewId: string }[]).map((r) => r.reviewId);

describe.skipIf(serverUrl === undefined)('review.list', () => {
  it('lists only the reviews the caller’s grant covers, across business, client and person', async () => {
    const onA = detailOf(await w.open(w.ava));
    const onB = detailOf(await w.open(w.dee, { taskId: w.taskB, pageUrl: B_PAGE, path: B_FILE }));
    const inBeta = detailOf(await w.open(w.eve, { taskId: w.betaTask }, w.beta));
    const [a, b, beta] = [onA['reviewId'], onB['reviewId'], inBeta['reviewId']] as string[];

    const ava = await list(w.ava);
    expect(ids(ava).toSorted()).toEqual([a, b].toSorted());
    const first = (ava['reviews'] as readonly Readonly<Record<string, unknown>>[]).find(
      (r) => r['reviewId'] === b,
    );
    expect(first).toMatchObject({
      taskId: w.taskB,
      pageUrl: B_PAGE,
      path: B_FILE,
      revisionCount: 1,
      latest: 'undecided',
    });

    // Another client in the same business: dee's party B grant lists B's review alone.
    expect(ids(await list(w.dee))).toEqual([b]);
    // Another business: eve lists beta's review, and ava's list in alpha never holds it.
    expect(ids(await list(w.eve, w.beta))).toEqual([beta]);
    // Another person with no review key: refused before any row is read.
    const cal = await list(w.cal);
    expect(cal['code']).toBe('SCOPE_NOT_GRANTED');

    for (const [answer, foreign] of [
      [ava, [beta]],
      [await list(w.dee), [a, beta]],
      [await list(w.eve, w.beta), [a, b]],
      [cal, [a, b, beta]],
    ] as const) {
      const body = JSON.stringify(answer);
      for (const id of foreign) expect(body).not.toContain(id);
    }
  });
});
