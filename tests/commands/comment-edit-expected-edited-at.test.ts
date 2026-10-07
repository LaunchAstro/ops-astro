// SPDX-License-Identifier: AGPL-3.0-only
//
// Two edits of one comment made from the same read, against a real database.
// An edit moves no task revision, so the task's `expectedRevision` cannot tell
// them apart; the edit names the comment's `edited_at` it was typed against,
// and the second one finds the first's stamp there and is refused stale. The
// first edit's words stay.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from './agent-fixture.ts';
import {
  as,
  commentIdOf,
  ids,
  post,
  revision,
  seedConversation,
  stored,
  thread,
  who,
  type Answer,
} from './conversation-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('comment edit precondition: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await seedConversation('cee');
}, 240_000);

afterAll(async () => {
  await who.world?.drop();
});

const editAgainst = async (
  recordId: string,
  commentId: string,
  body: string,
  expectedEditedAt: unknown,
): Promise<Answer> =>
  await as(who.decider, {
    command: 'task.edit_comment',
    recordId,
    expectedRevision: await revision(recordId),
    commentId,
    body,
    expectedEditedAt,
  });

const editedAtOf = async (recordId: string, commentId: string): Promise<unknown> =>
  (await thread(who.decider, recordId)).find((row) => row['id'] === commentId)?.['edited_at'];

describe.skipIf(serverUrl === undefined)('a comment edit names what it was typed against', () => {
  it('two edits from one read: the first applies, the second is refused stale', async () => {
    const recordId = ids['a'] ?? '';
    const commentId = commentIdOf(await post(who.decider, recordId, 'internal', 'first words'));
    const shown = await editedAtOf(recordId, commentId);
    expect(shown).toBeNull();
    const revisionBefore = await revision(recordId);

    const first = await editAgainst(recordId, commentId, 'from tab one', shown);
    expect(codeOf(first)).toBe('not-a-refusal');
    // The task revision did not move, so it alone cannot catch the second edit.
    expect(await revision(recordId)).toBe(revisionBefore);

    const second = await editAgainst(recordId, commentId, 'from tab two', shown);
    expect(codeOf(second)).toBe('VERSION_STALE');
    expect((await stored(commentId))?.body).toBe('from tab one');

    // Read again, the edit names the stamp it now sees and applies.
    const again = await editedAtOf(recordId, commentId);
    expect(typeof again).toBe('string');
    const third = await editAgainst(recordId, commentId, 'from tab two, reread', again);
    expect(codeOf(third)).toBe('not-a-refusal');
    expect((await stored(commentId))?.body).toBe('from tab two, reread');
  });

  it('an expectedEditedAt that is no instant is refused before the comment is read', async () => {
    const recordId = ids['a'] ?? '';
    const commentId = commentIdOf(await post(who.decider, recordId, 'internal', 'kept words'));
    for (const bad of [5, 'not a time', {}]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await editAgainst(recordId, commentId, 'changed', bad);
      expect(codeOf(answer)).toBe('FIELD_VALUE_INVALID');
    }
    expect((await stored(commentId))?.body).toBe('kept words');
  });
});
