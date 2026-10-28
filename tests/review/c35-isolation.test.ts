// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): reviews never cross a business or a client. Two businesses, two clients in
// the first, one review grant each: dee's on party B only, eve's in beta. Open, capture,
// read and the stored counts stay with the holder whose grant reaches them; a review out of
// reach reads as one that is not there, and a reviewed task keeps its client.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { B_FILE, B_PAGE, c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 isolation: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35iso');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const readCode = (read: Awaited<ReturnType<C35World['read']>>): string =>
  isCommandRefusal(read) ? read.code : 'not-a-refusal';

describe.skipIf(serverUrl === undefined)('C35 isolation', () => {
  it('C35 isolation', async () => {
    const onA = detailOf(await w.open(w.ava));
    const onB = detailOf(await w.open(w.dee, { taskId: w.taskB, pageUrl: B_PAGE, path: B_FILE }));
    expect(onB['number']).toBe(1);
    const inBeta = detailOf(await w.open(w.eve, { taskId: w.betaTask }, w.beta));
    expect(inBeta['number']).toBe(1);

    // dee's party B grant reaches party B's review and nothing of party A's.
    expect(codeOf(await w.open(w.dee))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.capture(w.dee, onA['revisionId']))).toBe('SCOPE_NOT_GRANTED');
    expect(readCode(await w.read(w.dee, onA['reviewId']))).toBe('NOT_FOUND');
    expect(readCode(await w.read(w.dee, onB['reviewId']))).toBe('not-a-refusal');
    expect(codeOf(await w.capture(w.dee, onB['revisionId']))).toBe('not-a-refusal');

    // eve's business-wide grant in beta reaches nothing of alpha's, by any id.
    expect(readCode(await w.read(w.eve, onA['reviewId'], w.beta))).toBe('NOT_FOUND');
    expect(codeOf(await w.capture(w.eve, onA['revisionId'], w.beta))).toBe('NOT_FOUND');
    expect(codeOf(await w.open(w.eve, {}, w.beta))).toBe('NOT_FOUND');
    // and ava's business-wide grant in alpha reaches nothing of beta's.
    expect(readCode(await w.read(w.ava, inBeta['reviewId']))).toBe('NOT_FOUND');
    expect(codeOf(await w.capture(w.ava, inBeta['revisionId']))).toBe('NOT_FOUND');

    // A reviewed task keeps its client: the review's holder can never come apart from it.
    const [task] = await w.world.db.admin.execute<{ readonly revision: number }>(
      'select revision from public.records where id = $1',
      [w.taskA],
    );
    const moved = await w.as(w.admin, {
      command: 'task.set_party',
      recordId: w.taskA,
      expectedRevision: Number(task?.revision),
      fields: { client: w.partyB },
    });
    expect(codeOf(moved)).toBe('CLIENT_LOCKED');

    expect(await w.count('reviews', w.world.business)).toBe(2);
    expect(await w.count('reviews', w.beta)).toBe(1);
    expect(await w.count('review_captures', w.world.business)).toBe(2);
    expect(await w.count('review_captures', w.beta)).toBe(0);
  });
});
