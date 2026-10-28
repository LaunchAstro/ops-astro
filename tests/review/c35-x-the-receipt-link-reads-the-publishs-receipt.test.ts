// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each correction's case beside the review it would join */
//
// C35-X (#2120): a revision opened for a page after its live correction published names that
// correction, as review metadata: `review.open` takes its id only for a correction on the
// review's own task and page that the opener's `run:write` reaches, and `review.read` gives the
// revision's correction back. The Receipt is then read through `live_correction.receipts`
// unchanged: a published correction's publish receipt, none for one not published, and a refusal
// for a reader the correction read does not reach. An unrelated or unreachable correction is
// refused at the open and joins nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { Member } from '../commands/fixture.ts';
import { published } from '../site/correction-reads-world.ts';
import { ABOUT, PAGE } from './c35-world.ts';
import { c35xWorld, type C35XWorld } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X receipt link: DATABASE_URL is unset.');

let w: C35XWorld;
let live: Awaited<ReturnType<typeof published>>;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35xWorld('c35xreceipt');
  await w.setApprover(w.ben.personId);
  live = await published(w, { published_revision: { observed: 'commit-2120abc' } });
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const openFor = async (member: Member, taskId: string, correctionId?: unknown) =>
  await w.open(member, {
    taskId,
    pageUrl: PAGE,
    path: ABOUT,
    sourceRevision: `rev-${randomUUID().slice(0, 8)}`,
    ...(correctionId === undefined ? {} : { correctionId }),
  });

/** The correction `review.read` names on each revision, by number. */
async function correctionsOf(reviewId: string): Promise<Readonly<Record<number, unknown>>> {
  const read = await w.read(w.ava, reviewId);
  if (!('review' in read)) throw new Error(`review.read refused: ${JSON.stringify(read)}`);
  const revisions = read.review.revisions as readonly {
    readonly number: number;
    readonly correctionId?: unknown;
  }[];
  return Object.fromEntries(revisions.map((each) => [each.number, each.correctionId]));
}

/** A correction requested on `taskId`'s about page, not decided. */
const requested = async (taskId: string): Promise<{ readonly id: string }> => ({
  id: String(detailOf(await w.request(w.ava, { taskId }))['correctionId']),
});

const receiptsAs = async (member: Member, correctionId: string) => {
  const read = await executeRead(w.world.db.app, w.world.business, member.presented, {
    read: 'live_correction.receipts',
    correctionId,
  } as never);
  return isCommandRefusal(read)
    ? read.code
    : (read as unknown as { readonly receipts: readonly Record<string, unknown>[] }).receipts.map(
        (receipt) => [receipt['step'], receipt['outcome']],
      );
};

describe.skipIf(serverUrl === undefined)('C35-X the Receipt link', () => {
  it('C35-X the Receipt link reads the publish’s receipt', async () => {
    // The revision opened on the published page names its correction.
    const opened = await openFor(w.ava, live.taskId, live.id.toUpperCase());
    expect(codeOf(opened)).toBe('not-a-refusal');
    const reviewId = String(detailOf(opened)['reviewId']);
    expect(await correctionsOf(reviewId)).toStrictEqual({ 1: live.id });
    expect(await receiptsAs(w.ava, live.id)).toStrictEqual([['publish', 'live']]);

    // Not published: it joins its own page's revision, and the read has no receipt to show.
    const waiting = await requested(live.taskId);
    expect(codeOf(await openFor(w.ava, live.taskId, waiting.id))).toBe('not-a-refusal');
    expect(await correctionsOf(reviewId)).toStrictEqual({ 1: live.id, 2: waiting.id });
    expect(await receiptsAs(w.ava, waiting.id)).toStrictEqual([]);

    // A revision opened with no correction names none.
    expect(codeOf(await openFor(w.ava, live.taskId))).toBe('not-a-refusal');
    expect(await correctionsOf(reviewId)).toStrictEqual({ 1: live.id, 2: waiting.id, 3: null });
  });

  it('an unrelated or unreachable correction joins no revision', async () => {
    const before = await w.count('review_revisions', w.world.business);
    // Another task's correction on the same page.
    const unrelated = await requested(w.taskA);
    const elsewhere = await openFor(w.ava, live.taskId, unrelated.id);
    // fay holds the review keys and no `run:write`: the correction read does not reach her.
    const unreachable = await openFor(w.fay, live.taskId, live.id);
    const answers = [
      elsewhere,
      unreachable,
      await openFor(w.ava, live.taskId, randomUUID()),
      await openFor(w.ava, live.taskId, 'not-a-correction'),
    ];
    for (const answer of answers) expect(codeOf(answer)).toBe('NOT_FOUND');
    // The refusal names the operand and nothing of the correction.
    expect(JSON.stringify(elsewhere)).not.toContain(unrelated.id);
    expect(await w.count('review_revisions', w.world.business)).toBe(before);
    expect(await receiptsAs(w.fay, live.id)).toBe('SCOPE_NOT_GRANTED');
    // The correction read and its grants are what they were: fay opens without one.
    expect(codeOf(await openFor(w.fay, live.taskId))).toBe('not-a-refusal');
  });
});
