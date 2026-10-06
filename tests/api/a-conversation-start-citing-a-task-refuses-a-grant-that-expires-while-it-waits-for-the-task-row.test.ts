// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.start` citing a task is admitted on the starter's
// `conversation:write` grant and asks `task:read` on the task, then keeps the
// conversation, whose scope's foreign key waits for the task's row while a
// task write holds it (`conversations.ts` `startConversation`). A grant that
// expires during that wait no longer counts: the start is refused and no
// conversation is kept (#444, security re-bind SEC-B1B-R6 R6-1, the class
// sweep of Sol PRV-oa-1035-R1 F1).
//
// The task row is held `for update` on another connection, as a task write
// holds it; the start is seen waiting on that holder with its transaction
// begun before the grant's expiry; the holder lets go once the database clock
// is past it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, holdRow, waitPast } from '../support/lock-wait-race.ts';
import { conversationWorld, expiringSoon, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/**
 * The colleague's start citing a new task, sent while the task row is held and
 * their one `collection:action` grant runs out: whether it was seen waiting
 * before the expiry, what it answered, and how many conversations cite the task.
 */
async function startAcross(
  w: ConversationWorld,
  collection: string,
  action: string,
): Promise<{ startedLive: boolean; status: number; code: unknown; kept: number }> {
  const person = w.colleague;
  const created = await w.as(w.owner, 'task.create', {
    fields: { title: `Cited across a ${collection}:${action} expiry` },
  });
  const taskId = (created.body as { recordId: string }).recordId;
  const db = w.fixture.db;
  const grant = await expiringSoon(w, person.personId, collection, action);
  const expiry = grant.expiry;
  const kept = 'select count(*) as n from public.conversations where scope_record_id = $1';
  const held = await holdRow(db, 'select id from public.records where id = $1 for update', [
    taskId,
  ]);
  const starting = w.as(person, 'conversation.start', {
    body: 'Sent across the expiry',
    scope: { kind: 'task', id: taskId },
  });
  let startedLive = false;
  try {
    startedLive = await blockedBefore(db, held, expiry);
    await waitPast(db, expiry);
  } finally {
    await held.letGo();
  }
  const answer = await starting;
  const seen = {
    startedLive,
    status: answer.status,
    code: answer.body['code'],
    kept: await w.count(kept, [taskId]),
  };
  // The grant stands again for the next case.
  await db.admin.execute('update public.grants set expires_at = null where id = $1', [grant.id]);
  return seen;
}

describe.skipIf(serverUrl === undefined)(
  'a grant expiring while a conversation start waits for its cited task',
  () => {
    let w: ConversationWorld;
    beforeAll(async () => {
      w = await conversationWorld('start_grant_expiry');
    }, 180_000);
    afterAll(async () => {
      await w?.drop();
    });

    // The door's grant is refused by name; the cited task's read is the one
    // answer citing gives for a task the caller cannot read (`citable`).
    it.each([
      ['conversation', 'write', 403, 'SCOPE_NOT_GRANTED'],
      ['task', 'read', 404, 'NOT_FOUND'],
    ] as const)(
      'a conversation start citing a task refuses a %s:%s grant that expires while it waits for the task row',
      async (collection, action, status, code) => {
        expect(await startAcross(w, collection, action)).toEqual({
          startedLive: true,
          status,
          code,
          kept: 0,
        });
      },
      30_000,
    );
  },
);
