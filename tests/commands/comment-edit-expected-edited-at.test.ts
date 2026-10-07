// SPDX-License-Identifier: AGPL-3.0-only
//
// Two edits of one comment made from the same read, against a real database.
// An edit moves no task revision, so the task's `expectedRevision` cannot tell
// them apart; the edit names the comment's `edited_at` it was typed against,
// and the second one finds the first's stamp there and is refused stale. The
// first edit's words stay. Each edit moves the stamp, so two replacements
// against one read are told apart even inside one transaction.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
import { readTaskComments } from '../../packages/core-records/src/tasks/comment-thread.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
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

type Session = Parameters<typeof runCommand>[1];

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

/** An edit's answer, and whether any statement it ran was handed the comment's id. */
const touches = async (
  recordId: string,
  commentId: string,
  expectedEditedAt: unknown,
): Promise<[string, boolean]> => {
  let named = false;
  const expectedRevision = await revision(recordId);
  const answer = await withSession(
    who.world.db.app,
    who.world.business,
    who.decider.presented,
    async (tx, session) => {
      const watched: TenantQuery = {
        businessId: tx.businessId,
        query: async (text, parameters) => {
          if (parameters?.includes(commentId) === true) named = true;
          return await tx.query(text, parameters);
        },
      };
      return await runCommand(watched, session, 'api', {
        command: 'task.edit_comment',
        operationId: randomUUID(),
        recordId,
        expectedRevision,
        commentId,
        body: 'changed',
        expectedEditedAt,
      } as never);
    },
  );
  return [codeOf(answer as never), named];
};

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
      expect(await touches(recordId, commentId, bad)).toEqual(['FIELD_VALUE_INVALID', false]);
    }
    expect((await stored(commentId))?.body).toBe('kept words');
    // The same request with a stamp that is an instant does look the comment up.
    expect(await touches(recordId, commentId, null)).toEqual(['not-a-refusal', true]);
  });
});

describe.skipIf(serverUrl === undefined)('an edit moves the stamp it is checked against', () => {
  it('two replacements from one read inside one transaction: the second is refused stale', async () => {
    const recordId = ids['a'] ?? '';
    const commentId = commentIdOf(await post(who.decider, recordId, 'internal', 'posted words'));
    const expectedRevision = await revision(recordId);
    const replace = async (
      tx: TenantQuery,
      session: Session,
      body: string,
      expectedEditedAt?: string,
    ) =>
      codeOf(
        await runCommand(tx, session, 'api', {
          command: 'task.edit_comment',
          operationId: randomUUID(),
          recordId,
          expectedRevision,
          commentId,
          body,
          ...(expectedEditedAt === undefined ? {} : { expectedEditedAt }),
        } as never),
      );

    const codes = await withSession(
      who.world.db.app,
      who.world.business,
      who.decider.presented,
      async (tx, session) => {
        const snapshotEdit = await replace(tx, session, 'snapshot words');
        const [typed] = await tx.query<{ readonly type: string }>(
          `select record_type_id::text as type from public.records where id = $1`,
          [commentId],
        );
        const shown = (await readTaskComments(tx, typed?.type ?? '', recordId)).find(
          (comment) => comment.id === commentId,
        )?.editedAt;
        const snapshot = shown?.toISOString() ?? '';
        expect(snapshot).not.toBe('');
        const first = await replace(tx, session, 'first replacement', snapshot);
        const second = await replace(tx, session, 'second replacement', snapshot);
        return [snapshotEdit, first, second];
      },
    );
    expect(codes).toEqual(['not-a-refusal', 'not-a-refusal', 'VERSION_STALE']);
    expect((await stored(commentId))?.body).toBe('first replacement');
  });
});
